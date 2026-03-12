#!/usr/bin/env node

// Prophet Agent Web Server - SSE streaming dashboard + agent control
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import axios from 'axios';
import { AgentHarness, buildSystemPrompt } from './harness.js';
import {
  loadConfig, getConfig, saveConfig,
  addAccount, removeAccount, setActiveAccount, getActiveAccount,
  addAgent, updateAgent, removeAgent, setActiveAgent, getActiveAgent,
  addStrategy, updateStrategy, removeStrategy,
  setActiveModel,
  updateHeartbeat, getHeartbeatForPhase,
  updatePermissions, getPermissions,
  updatePlugin, getPlugin,
} from './config-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = process.env.AGENT_PORT || 3737;
const TRADING_BOT_PORT = process.env.TRADING_BOT_PORT || '4534';
const TRADING_BOT_URL = process.env.TRADING_BOT_URL || `http://localhost:${TRADING_BOT_PORT}`;

// Pooled HTTP agent for Go backend calls — reuses TCP connections
const goHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });
const goAxios = axios.create({ baseURL: TRADING_BOT_URL, httpAgent: goHttpAgent, timeout: 5000 });

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Auth Middleware ────────────────────────────────────────────────
// Token-based auth. Set AGENT_AUTH_TOKEN env var to enable.
// Without it, server is open (for local dev). With it, all API routes require the token.
const AUTH_TOKEN = process.env.AGENT_AUTH_TOKEN || '';
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured = open access
  // Allow health check unauthenticated
  if (req.path === '/api/health') return next();
  // Check Authorization header or query param
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <token> header.' });
}
app.use('/api', authMiddleware);

// ── Go Backend Manager ─────────────────────────────────────────────
// Manages the Go trading bot lifecycle, supports restarting with different Alpaca keys
let goProc = null;
let goReady = false;

async function startGoBackend(account) {
  // Kill existing if running
  await stopGoBackend();

  if (!account) {
    console.log('  No active account — Go backend not started');
    return false;
  }

  // Build binary if needed
  const binaryPath = path.join(PROJECT_ROOT, 'prophet_bot');
  try {
    const fs = await import('fs');
    if (!fs.existsSync(binaryPath)) {
      console.log('  Building Go binary...');
      execSync('go build -o prophet_bot ./cmd/bot', { cwd: PROJECT_ROOT, timeout: 60000 });
    }
  } catch (err) {
    console.error('  Failed to build Go binary:', err.message);
    return false;
  }

  const env = {
    ...process.env,
    ALPACA_API_KEY: account.publicKey,
    ALPACA_SECRET_KEY: account.secretKey,
    ALPACA_BASE_URL: account.baseUrl || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    ALPACA_PAPER: account.paper ? 'true' : 'false',
    PORT: TRADING_BOT_PORT,
  };

  console.log(`  Starting Go backend for account "${account.name}" (${account.paper ? 'paper' : 'live'})...`);

  goProc = spawn(binaryPath, [], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  goProc.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`  [go] ${msg}`);
  });
  goProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`  [go-err] ${msg}`);
  });
  goProc.on('exit', (code, signal) => {
    console.log(`  Go backend exited (code: ${code}, signal: ${signal})`);
    goReady = false;
    goProc = null;
    // Auto-restart on unexpected crash (not manual stop)
    if (code !== 0 && code !== null && signal !== 'SIGTERM') {
      console.log('  Go backend crashed — auto-restarting in 5s...');
      broadcast('agent_log', {
        message: 'Trading backend crashed — auto-restarting in 5s...',
        level: 'error',
        timestamp: new Date().toISOString(),
      });
      setTimeout(() => {
        const acc = getActiveAccount();
        if (acc) startGoBackend(acc);
      }, 5000);
    }
  });

  // Wait for health check
  goReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      await goAxios.get('/health', { timeout: 2000 });
      goReady = true;
      console.log(`  Go backend ready on port ${TRADING_BOT_PORT} (account: ${account.name})`);
      broadcast('agent_log', {
        message: `Trading backend started for account "${account.name}" (${account.paper ? 'paper' : 'live'})`,
        level: 'success',
        timestamp: new Date().toISOString(),
      });
      return true;
    } catch {}
  }

  console.error('  Go backend failed to start within 10s');
  broadcast('agent_log', {
    message: 'Trading backend failed to start. Check logs.',
    level: 'error',
    timestamp: new Date().toISOString(),
  });
  return false;
}

async function stopGoBackend() {
  if (goProc) {
    const pid = goProc.pid;
    goProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    // Check if still alive
    try { process.kill(pid, 0); goProc.kill('SIGKILL'); } catch {}
    goProc = null;
    goReady = false;
    await new Promise(r => setTimeout(r, 500));
  }
  // Kill any orphaned Go backend on the port (but NOT our own Node process)
  const myPid = process.pid;
  try {
    const pids = execSync(`lsof -t -i :${TRADING_BOT_PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        const p = parseInt(pid);
        if (p && p !== myPid) {
          try { process.kill(p, 'SIGTERM'); } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch {}
}

// ── Load Config ────────────────────────────────────────────────────
await loadConfig();

// ── Agent Instance ─────────────────────────────────────────────────
const harness = new AgentHarness();
const sseClients = new Set();

function broadcast(event, data) {
  if (sseClients.size === 0) return; // skip serialization when no clients connected
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

const EVENTS = [
  'status', 'agent_log', 'agent_text', 'beat_start', 'beat_end',
  'tool_call', 'tool_result', 'heartbeat_change', 'schedule', 'trade',
];
for (const evt of EVENTS) {
  harness.state.on(evt, (data) => {
    broadcast(evt, { ...data, timestamp: new Date().toISOString() });
  });
}

// ── Slack Notification Dispatcher ──────────────────────────────────
async function notifySlack(text) {
  try {
    const slack = getPlugin('slack');
    if (!slack?.enabled || !slack?.webhookUrl) return;
    await axios.post(slack.webhookUrl, {
      text,
      channel: slack.channel || undefined,
    }, { timeout: 5000 });
  } catch (err) {
    console.error('Slack notification failed:', err.message);
  }
}

function slackEnabled(event) {
  const slack = getPlugin('slack');
  return slack?.enabled && slack?.webhookUrl && slack?.notifyOn?.[event];
}

// Agent start/stop
harness.state.on('status', (data) => {
  if (!slackEnabled('agentStartStop')) return;
  if (data.status === 'started') {
    notifySlack(`:rocket: *Prophet Agent Started*\nAgent: ${data.agent || 'Unknown'}\nModel: ${data.model || 'Unknown'}\nAccount: ${data.account || 'N/A'}`);
  } else if (data.status === 'stopped') {
    notifySlack(`:octagonal_sign: *Prophet Agent Stopped*`);
  }
});

// Trade executed
harness.state.on('trade', (trade) => {
  if (!slackEnabled('tradeExecuted')) return;
  const side = (trade.side || '').toUpperCase();
  const emoji = side === 'BUY' ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
  notifySlack(`${emoji} *Trade Executed*\n${side} ${trade.quantity || '?'}x ${trade.symbol || '??'}${trade.price ? ' @ $' + trade.price : ''}\nTool: ${trade.tool || 'unknown'}`);
});

// Errors
harness.state.on('agent_log', (data) => {
  if (data.level !== 'error' || !slackEnabled('errors')) return;
  notifySlack(`:warning: *Prophet Error*\n${data.message}`);
});

// Position opened (detect from trade events with buy-side tools)
harness.state.on('trade', (trade) => {
  const side = (trade.side || '').toLowerCase();
  if (side === 'buy' && slackEnabled('positionOpened')) {
    notifySlack(`:new: *Position Opened*\n${(trade.symbol || '??')} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`);
  }
  if (side === 'sell' && slackEnabled('positionClosed')) {
    notifySlack(`:checkered_flag: *Position Closed*\n${(trade.symbol || '??')} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`);
  }
});

// Daily summary — schedule at 4:30 PM ET
function scheduleDailySummary() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(et);
  target.setHours(16, 30, 0, 0);
  if (et >= target) target.setDate(target.getDate() + 1);
  const ms = target.getTime() - et.getTime();
  setTimeout(async () => {
    if (slackEnabled('dailySummary')) {
      try {
        const { data: acc } = await goAxios.get('/api/v1/account');
        const equity = Number(acc.Equity || acc.equity || 0);
        const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
        const pnl = equity - lastEquity;
        const pnlPct = lastEquity ? ((pnl / lastEquity) * 100).toFixed(2) : '0.00';
        const emoji = pnl >= 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
        notifySlack(`${emoji} *Daily Summary*\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)\nPortfolio: $${equity.toFixed(2)}\nBeats: ${harness.state.stats.totalBeats} | Trades: ${harness.state.stats.trades} | Errors: ${harness.state.stats.errors}`);
      } catch {}
    }
    scheduleDailySummary(); // reschedule for tomorrow
  }, ms);
}
scheduleDailySummary();

// Heartbeat (opt-in, noisy)
harness.state.on('beat_start', (data) => {
  if (!slackEnabled('heartbeat')) return;
  notifySlack(`:heartbeat: Beat #${data.beat} | Phase: ${data.phase}`);
});

// ── Daily Loss Circuit Breaker ─────────────────────────────────────
harness.state.on('beat_end', async () => {
  try {
    const perms = getPermissions();
    if (!perms.maxDailyLoss || perms.maxDailyLoss <= 0) return;
    const { data: acc } = await goAxios.get('/api/v1/account', { timeout: 3000 });
    const equity = Number(acc.Equity || acc.equity || 0);
    const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
    if (!lastEquity) return;
    const dayLossPct = ((equity - lastEquity) / lastEquity) * 100;
    if (dayLossPct <= -perms.maxDailyLoss) {
      if (!harness.state.paused) {
        harness.pause();
        const msg = `CIRCUIT BREAKER: Daily loss ${dayLossPct.toFixed(2)}% exceeds -${perms.maxDailyLoss}% limit. Agent auto-paused.`;
        broadcast('agent_log', { message: msg, level: 'error', timestamp: new Date().toISOString() });
        if (slackEnabled('errors')) notifySlack(`:rotating_light: ${msg}`);
      }
    }
  } catch { /* silently skip if account unavailable */ }
});

// ── SSE Endpoint ───────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: state\ndata: ${JSON.stringify(harness.state.toJSON())}\n\n`);
  res.write(`event: config\ndata: ${JSON.stringify(safeConfig())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Agent Control ──────────────────────────────────────────────────
app.post('/api/agent/start', async (req, res) => {
  try {
    await harness.start();
    res.json({ ok: true, status: 'started' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/stop', (req, res) => {
  harness.stop();
  res.json({ ok: true, status: 'stopped' });
});

app.post('/api/agent/pause', (req, res) => {
  harness.pause();
  res.json({ ok: true, status: 'paused' });
});

app.post('/api/agent/resume', (req, res) => {
  harness.resume();
  res.json({ ok: true, status: 'resumed' });
});

app.post('/api/agent/message', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const result = await harness.sendMessage(message.trim());
    res.json({ ok: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/agent/state', (req, res) => {
  res.json(harness.state.toJSON());
});

// ── Order Confirmation ─────────────────────────────────────────────
// When requireConfirmation is enabled, the MCP server checks /api/permissions
// and returns an error asking the agent to wait. The operator must approve via UI.
// This is enforced at the MCP permission layer (enforcePermissions function).
// The UI can show a confirmation prompt — for now, requireConfirmation
// makes the MCP server reject orders with a "requires confirmation" error.
// The agent will see this error and should report it to the operator.

app.post('/api/agent/heartbeat', (req, res) => {
  const { seconds, reason } = req.body;
  if (!seconds || seconds < 30 || seconds > 3600) return res.status(400).json({ error: 'seconds must be 30-3600' });
  harness.state.heartbeatOverride = { seconds, reason: reason || 'Manual override', oneTime: false };
  harness.state.emit('heartbeat_change', { seconds, reason: reason || 'Manual override from UI' });
  res.json({ ok: true, seconds });
});

// ── Safe Config (strip secrets) ────────────────────────────────────
function safeConfig() {
  const cfg = { ...getConfig() };
  // Strip secret keys from accounts
  cfg.accounts = (cfg.accounts || []).map(a => ({ ...a, secretKey: a.secretKey ? '****' + a.secretKey.slice(-4) : '****' }));
  return cfg;
}

// ── Config CRUD ────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(safeConfig());
});

// System prompt preview
app.get('/api/agent/prompt-preview', async (req, res) => {
  try {
    const agentConfig = getActiveAgent();
    const prompt = await buildSystemPrompt(agentConfig);
    res.json({ prompt, agentName: agentConfig.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Accounts
app.get('/api/accounts', (req, res) => {
  const config = getConfig();
  // Don't expose secret keys to frontend
  const safe = config.accounts.map(a => ({ ...a, secretKey: '****' + a.secretKey.slice(-4) }));
  res.json({ accounts: safe, activeId: config.activeAccountId });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const account = await addAccount(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, account: { ...account, secretKey: '****' } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    await removeAccount(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/accounts/:id/activate', async (req, res) => {
  try {
    await setActiveAccount(req.params.id);
    const account = getActiveAccount();
    broadcast('config', safeConfig());
    // Restart Go backend with new account credentials
    if (account) {
      broadcast('agent_log', {
        message: `Switching to account "${account.name}"... restarting trading backend.`,
        level: 'info',
        timestamp: new Date().toISOString(),
      });
      await startGoBackend(account);
    }
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Agents
app.get('/api/agents', (req, res) => {
  const config = getConfig();
  res.json({ agents: config.agents, activeId: config.activeAgentId });
});

app.post('/api/agents', async (req, res) => {
  try {
    const agent = await addAgent(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/agents/:id', async (req, res) => {
  try {
    const agent = await updateAgent(req.params.id, req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    await removeAgent(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/agents/:id/activate', async (req, res) => {
  try {
    await setActiveAgent(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Strategies
app.get('/api/strategies', (req, res) => {
  const config = getConfig();
  res.json({ strategies: config.strategies });
});

app.post('/api/strategies', async (req, res) => {
  try {
    const strategy = await addStrategy(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, strategy });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/strategies/:id', async (req, res) => {
  try {
    const strategy = await updateStrategy(req.params.id, req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, strategy });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/strategies/:id', async (req, res) => {
  try {
    await removeStrategy(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Model selection
app.get('/api/models', (req, res) => {
  const config = getConfig();
  res.json({ models: config.models, activeModel: config.activeModel });
});

app.post('/api/models/activate', async (req, res) => {
  try {
    await setActiveModel(req.body.model);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Heartbeat Config ───────────────────────────────────────────────
app.get('/api/heartbeat', (req, res) => {
  const config = getConfig();
  res.json(config.heartbeat || {});
});

app.put('/api/heartbeat', async (req, res) => {
  try {
    await updateHeartbeat(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Permissions / Guardrails ───────────────────────────────────────
app.get('/api/permissions', (req, res) => {
  res.json(getPermissions());
});

app.put('/api/permissions', async (req, res) => {
  try {
    await updatePermissions(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Plugins ────────────────────────────────────────────────────────
app.get('/api/plugins', (req, res) => {
  const config = getConfig();
  res.json(config.plugins || {});
});

app.get('/api/plugins/:name', (req, res) => {
  const plugin = getPlugin(req.params.name);
  res.json(plugin || {});
});

app.put('/api/plugins/:name', async (req, res) => {
  try {
    await updatePlugin(req.params.name, req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/plugins/slack/test', async (req, res) => {
  try {
    const slack = getPlugin('slack');
    if (!slack?.webhookUrl) return res.status(400).json({ error: 'No Slack webhook URL configured' });
    const { default: axios } = await import('axios');
    await axios.post(slack.webhookUrl, {
      text: ':robot_face: *Prophet Agent* - Test notification\nSlack integration is working!',
      channel: slack.channel || undefined,
    }, { timeout: 5000 });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to send test message: ' + err.message }); }
});

// ── Portfolio Proxy ────────────────────────────────────────────────
app.get('/api/portfolio/account', async (req, res) => {
  try {
    const { data } = await goAxios.get('/api/v1/account');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

app.get('/api/portfolio/positions', async (req, res) => {
  try {
    const { data } = await goAxios.get('/api/v1/options/positions');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

app.get('/api/portfolio/orders', async (req, res) => {
  try {
    const { data } = await goAxios.get('/api/v1/orders');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

// ── Auth (OpenCode) ────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  // API key in env is the fastest check
  if (process.env.ANTHROPIC_API_KEY) {
    return res.json({
      loggedIn: true,
      authMethod: 'api_key',
      provider: 'opencode',
      raw: 'ANTHROPIC_API_KEY set in environment',
    });
  }
  try {
    const out = execSync('opencode auth list 2>&1', { timeout: 5000, encoding: 'utf-8' });
    // Parse the table output - look for "Anthropic" with "oauth" or any credential
    const hasAnthropicAuth = out.includes('Anthropic') && (out.includes('oauth') || out.includes('api-key'));
    res.json({
      loggedIn: hasAnthropicAuth,
      authMethod: hasAnthropicAuth ? 'opencode_oauth' : 'none',
      provider: 'opencode',
      raw: out.replace(/\x1b\[[0-9;]*m/g, '').trim(), // strip ANSI codes
    });
  } catch (err) {
    const output = (err.stdout || err.stderr || err.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    res.json({ loggedIn: false, provider: 'opencode', raw: output.substring(0, 200) });
  }
});

app.post('/api/auth/login', (req, res) => {
  // Spawn opencode auth login and capture the URL
  const proc = spawn('opencode', ['auth', 'login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'echo' }, // prevent auto-opening browser
  });

  let output = '';
  let urlSent = false;

  const sendUrl = (data) => {
    output += data.toString();
    // Look for any OAuth/auth URL
    const match = output.match(/(https:\/\/[^\s]+authorize[^\s]*)/);
    if (match && !urlSent) {
      urlSent = true;
      res.json({ ok: true, url: match[1] });
      proc.on('exit', (code) => {
        broadcast('agent_log', {
          message: code === 0 ? 'OpenCode authenticated successfully!' : 'Auth flow ended (code: ' + code + ')',
          level: code === 0 ? 'success' : 'warning',
          timestamp: new Date().toISOString(),
        });
      });
    }
  };

  proc.stdout.on('data', sendUrl);
  proc.stderr.on('data', sendUrl);

  // Also handle interactive prompts - pipe newline to accept defaults
  setTimeout(() => {
    try { proc.stdin.write('\n'); } catch {}
  }, 2000);

  // Timeout - if no URL found in 15s, return error
  setTimeout(() => {
    if (!urlSent) {
      proc.kill();
      res.status(500).json({ error: 'Timed out waiting for auth URL', output: output.substring(0, 500) });
    }
  }, 15000);
});

app.post('/api/auth/logout', (req, res) => {
  try {
    execSync('opencode auth logout 2>&1', { timeout: 10000, encoding: 'utf-8' });
    broadcast('agent_log', {
      message: 'OpenCode logged out.',
      level: 'info',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || '';
    res.status(500).json({ error: 'Logout failed: ' + output.substring(0, 200) });
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let botHealthy = false;
  try {
    await goAxios.get('/health', { timeout: 3000 });
    botHealthy = true;
  } catch {}
  const account = getActiveAccount();
  res.json({
    agent: 'healthy',
    trading_bot: botHealthy ? 'healthy' : 'unavailable',
    trading_bot_managed: goProc !== null,
    activeAccount: account ? { name: account.name, paper: account.paper } : null,
    uptime: process.uptime(),
    state: harness.state.toJSON(),
  });
});

// Serve static files (after API routes)
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback - serve index.html for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// ── Start Server ───────────────────────────────────────────────────

// Start Go backend with active account
const activeAccount = getActiveAccount();
if (activeAccount) {
  await startGoBackend(activeAccount);
} else {
  console.log('  No active account configured — Go backend not started');
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n  Shutting down...');
  harness.stop();
  await stopGoBackend();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  harness.stop();
  await stopGoBackend();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Prophet Agent Dashboard: http://localhost:${PORT}`);
  console.log(`  Network:                http://0.0.0.0:${PORT}`);
  console.log(`  Trading Bot Backend:    ${TRADING_BOT_URL}`);
  console.log(`  Active Account:         ${activeAccount?.name || 'none'}\n`);
});
