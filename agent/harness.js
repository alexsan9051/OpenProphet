// Prophet Agent Harness - Autonomous trading agent with phased heartbeat
// Uses claude CLI subprocess for auth (OAuth/API key handled by CLI)
import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { getConfig, getActiveAgent, getActiveAccount, getHeartbeatForPhase, getPermissions } from './config-store.js';

// Default max tool rounds; overridden by permissions config at runtime

// ── Phase Configuration ────────────────────────────────────────────
export const PHASE_DEFAULTS = {
  pre_market:   { seconds: 900,  label: 'Pre-Market',    range: [240, 570]  },
  market_open:  { seconds: 120,  label: 'Market Open',   range: [570, 630]  },
  midday:       { seconds: 600,  label: 'Midday',        range: [630, 900]  },
  market_close: { seconds: 120,  label: 'Market Close',  range: [900, 960]  },
  after_hours:  { seconds: 1800, label: 'After Hours',   range: [960, 1200] },
  closed:       { seconds: 3600, label: 'Markets Closed', range: null },
};

export function getCurrentPhase() {
  const now = new Date();
  const et = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = et.split(':').map(Number);
  const mins = h * 60 + m;
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  if (!weekday) return 'closed';
  for (const [phase, cfg] of Object.entries(PHASE_DEFAULTS)) {
    if (cfg.range && mins >= cfg.range[0] && mins < cfg.range[1]) return phase;
  }
  return 'closed';
}

// ── System Prompt Builder ──────────────────────────────────────────
export async function buildSystemPrompt(agentConfig) {
  let strategyRules = '';
  if (agentConfig.strategyId) {
    const config = getConfig();
    const strategy = config.strategies.find(s => s.id === agentConfig.strategyId);
    if (strategy) {
      if (strategy.rulesFile) {
        try { strategyRules = await fs.readFile(path.join(process.cwd(), strategy.rulesFile), 'utf-8'); } catch (err) { console.error(`Warning: Failed to load strategy rules file "${strategy.rulesFile}":`, err.message); }
      } else if (strategy.customRules) {
        strategyRules = strategy.customRules;
      }
    }
  }

  if (agentConfig.systemPromptTemplate === 'custom' && agentConfig.customSystemPrompt) {
    return agentConfig.customSystemPrompt + (strategyRules ? `\n\n## Strategy Rules\n${strategyRules}` : '');
  }

  let tradingRules = strategyRules;
  if (!tradingRules) {
    try { tradingRules = await fs.readFile(path.join(process.cwd(), 'TRADING_RULES.md'), 'utf-8'); } catch (err) { console.error('Warning: TRADING_RULES.md not found:', err.message); tradingRules = ''; }
  }

  return `You are ${agentConfig.name || 'Prophet'}, an autonomous AI options trading agent. You run on a heartbeat loop — each time you wake up, you assess the market, manage positions, and decide what to do.

## Your Identity
- ${agentConfig.description || 'You are a disciplined, aggressive options trader'}
- You trade options (calls AND puts) based on conditions
- You are running autonomously — no human is approving your actions in real-time
- You have access to MCP tools for trading, market data, news, and analysis

## Each Heartbeat You Should
1. Check the time and market status
2. Review account status and positions
3. Based on phase and positions, decide what to do:
   - Pre-market: Gather intelligence, plan the day, review overnight news
   - Market open: Execute planned trades, monitor for opportunities
   - Midday: Monitor positions, check stops, look for setups
   - Market close: Review positions, close expiring options, decide overnight holds
   - After hours: Review the day, log activity, plan tomorrow
4. Execute trades following the rules
5. End with a summary of what you did

## Critical Rules
- ALWAYS use limit orders on options (never market orders)
- Maximum 15% of portfolio per position
- Maximum 10 positions simultaneously
- Cut losers at -15% or thesis break
- Take profits at +25-50%
- Maintain 50-70% cash at all times
- Maximum -5% portfolio daily loss = stop trading
- Log all major decisions with log_decision

${tradingRules ? `## Trading Rules\n${tradingRules}` : ''}

## Important
- Be decisive. Analyze and act.
- Don't waste heartbeats on excessive analysis.
- If nothing to do, say so briefly.
- Always log your reasoning for trades.`;
}

// ── Check CLI auth ─────────────────────────────────────────────────
export function checkCliAuth() {
  // API key in env takes precedence — OpenCode picks it up automatically
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const out = execSync('opencode auth list 2>&1', { timeout: 5000, encoding: 'utf-8' });
    // Look for Anthropic credential (oauth or env) in the output
    return out.includes('Anthropic');
  } catch {
    return false;
  }
}

// ── Agent State ────────────────────────────────────────────────────
export class AgentState extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.paused = false;
    this.phase = 'closed';
    this.heartbeatSeconds = 120;
    this.heartbeatOverride = null;
    this.beatCount = 0;
    this.lastBeatTime = null;
    this.nextBeatTime = null;
    this.activeAgentId = null;
    this.activeAccountId = null;
    this.activeModel = null;
    this.recentTrades = [];
    this.stats = {
      totalBeats: 0,
      toolCalls: 0,
      trades: 0,
      errors: 0,
      startedAt: null,
    };
  }

  addTrade(trade) {
    this.recentTrades.unshift({ ...trade, timestamp: new Date().toISOString() });
    if (this.recentTrades.length > 50) this.recentTrades.pop();
    this.emit('trade', trade);
  }

  toJSON() {
    return {
      running: this.running,
      paused: this.paused,
      phase: this.phase,
      phaseLabel: PHASE_DEFAULTS[this.phase]?.label || 'Unknown',
      heartbeatSeconds: this.heartbeatSeconds,
      heartbeatOverride: this.heartbeatOverride,
      beatCount: this.beatCount,
      lastBeatTime: this.lastBeatTime,
      nextBeatTime: this.nextBeatTime,
      activeAgentId: this.activeAgentId,
      activeAccountId: this.activeAccountId,
      activeModel: this.activeModel,
      recentTrades: this.recentTrades.slice(0, 10),
      stats: this.stats,
    };
  }
}

// ── Agent Harness (CLI subprocess) ─────────────────────────────────
export class AgentHarness {
  constructor() {
    this.state = new AgentState();
    this.systemPrompt = '';
    this._timer = null;
    this._beating = false;
    this._agentConfig = null;
    this._sessionId = null; // persist session across beats for context
    this._proc = null;       // current opencode subprocess
    this._pendingMessages = [];
    this._interrupted = false;
    this._beatTimeout = null;
  }

  async start() {
    if (this.state.running) return;

    // Check CLI auth
    if (!checkCliAuth()) {
      throw new Error('OpenCode not authenticated. Run "opencode auth login" or set ANTHROPIC_API_KEY in .env');
    }

    const config = getConfig();
    this._agentConfig = getActiveAgent();
    const model = this._agentConfig.model || config.activeModel;
    const account = getActiveAccount();

    this.state.activeAgentId = this._agentConfig.id;
    this.state.activeAccountId = account?.id || null;
    this.state.activeModel = model;

    this.systemPrompt = await buildSystemPrompt(this._agentConfig);
    this.state.running = true;
    this.state.paused = false;
    this.state.stats = { totalBeats: 0, toolCalls: 0, trades: 0, errors: 0, startedAt: new Date().toISOString() };
    this.state.beatCount = 0;
    this.state.recentTrades = [];
    this._sessionId = null;

    this.state.emit('status', { status: 'started', agent: this._agentConfig.name, model, account: account?.name });
    this.state.emit('agent_log', {
      message: `Agent "${this._agentConfig.name}" started on ${model}${account ? ` | Account: ${account.name}` : ''}`,
      level: 'success',
    });

    await this._beat();
    this._scheduleNext();
  }

  stop() {
    this.state.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._beatTimeout) { clearTimeout(this._beatTimeout); this._beatTimeout = null; }
    // Kill any running subprocess
    const procToKill = this._proc;
    if (procToKill && !procToKill.killed) {
      procToKill.kill('SIGTERM');
      setTimeout(() => {
        if (!procToKill.killed) procToKill.kill('SIGKILL');
      }, 2000);
    }
    this.state.emit('status', { status: 'stopped' });
    this.state.emit('agent_log', { message: 'Agent stopped.', level: 'warning' });
  }

  pause() {
    this.state.paused = true;
    this.state.emit('status', { status: 'paused' });
    this.state.emit('agent_log', { message: 'Agent paused.', level: 'warning' });
  }

  resume() {
    this.state.paused = false;
    this.state.emit('status', { status: 'resumed' });
    this.state.emit('agent_log', { message: 'Agent resumed.', level: 'success' });
  }

  /**
   * Send a user message to the agent.
   * - If idle: triggers an immediate ad-hoc beat with the message.
   * - If busy: interrupts the current beat (kills the opencode process),
   *   then resumes the SAME session with the user's message so context is preserved.
   */
  async sendMessage(message) {
    if (!this.state.running) {
      throw new Error('Agent is not running. Start the agent first.');
    }

    this.state.emit('agent_log', {
      message: `User: ${message}`,
      level: 'info',
    });

    if (this._beating) {
      // Interrupt the current beat
      this.state.emit('agent_log', {
        message: 'Interrupting current beat to handle user message...',
        level: 'warning',
      });

      this._interrupted = true;

      // Kill the running opencode subprocess — capture ref so the
      // SIGKILL fallback targets THIS process, not a future one.
      const procToKill = this._proc;
      if (procToKill && !procToKill.killed) {
        procToKill.kill('SIGTERM');
        setTimeout(() => {
          if (!procToKill.killed) {
            procToKill.kill('SIGKILL');
          }
        }, 2000);
      }

      // Fire the follow-up beat asynchronously (don't await — return immediately)
      this._interruptAndResume(message);
      return { interrupted: true, sent: true };
    }

    // Not busy — cancel the scheduled next beat and run immediately
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    // Also fire async so the HTTP response returns fast
    this._fireAdHocBeat(message);
    return { sent: true };
  }

  /** Wait for current beat to die, then run ad-hoc beat with user message */
  async _interruptAndResume(message) {
    // Wait for the current beat to finish its cleanup
    await new Promise((resolve) => {
      const check = () => {
        if (!this._beating) return resolve();
        setTimeout(check, 100);
      };
      check();
    });

    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    await this._adHocBeat(message);
    this._scheduleNext();
  }

  /** Cancel scheduled beat and fire an ad-hoc beat, then reschedule */
  async _fireAdHocBeat(message) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    await this._adHocBeat(message);
    this._scheduleNext();
  }

  async _adHocBeat(userMessage) {
    if (this._beating) return;
    this._beating = true;

    const beatNum = ++this.state.beatCount;
    this.state.stats.totalBeats = beatNum;
    this.state.lastBeatTime = new Date().toISOString();
    const phase = getCurrentPhase();
    this.state.phase = phase;
    const model = this.state.activeModel;

    // Drain any queued messages
    const queued = this._pendingMessages || [];
    this._pendingMessages = [];
    const allMessages = [userMessage, ...queued].filter(Boolean);
    const userBlock = allMessages.map(m => `USER MESSAGE: ${m}`).join('\n');

    this.state.emit('beat_start', { beat: beatNum, phase, time: this.state.lastBeatTime });
    this.state.emit('agent_log', {
      message: `--- Message Beat #${beatNum} ---`,
      level: 'info',
    });

    const prompt = `[MESSAGE BEAT #${beatNum}] Phase: ${PHASE_DEFAULTS[phase].label}. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.\n\nThe user/operator is sending you a direct message. Read it carefully and act on it. You can use your tools, modify your behavior, update strategies, etc.\n\n${userBlock}`;

    try {
      const result = await this._runClaude(prompt, model);
      if (result.error) throw new Error(result.error);
      // Text already streamed via _handleOpenCodeEvent agent_text events
      if (result.toolCalls) this.state.stats.toolCalls += result.toolCalls;
      if (result.sessionId) this._sessionId = result.sessionId;
    } catch (err) {
      this.state.stats.errors++;
      this.state.emit('agent_log', { message: `Message beat error: ${err.message}`, level: 'error' });
    }

    this.state.emit('beat_end', { beat: beatNum, phase });
    this._beating = false;
  }

  _getHeartbeatSeconds() {
    if (this.state.heartbeatOverride) {
      const override = this.state.heartbeatOverride;
      if (override.oneTime) this.state.heartbeatOverride = null;
      return override.seconds;
    }
    const phase = getCurrentPhase();
    this.state.phase = phase;
    // Agent-level overrides take priority, then global config, then hardcoded defaults
    if (this._agentConfig?.heartbeatOverrides?.[phase]) {
      return this._agentConfig.heartbeatOverrides[phase];
    }
    return getHeartbeatForPhase(phase);
  }

  _scheduleNext() {
    if (!this.state.running) return;
    // Always clear any existing timer first to prevent dual timers
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const seconds = this._getHeartbeatSeconds();
    this.state.heartbeatSeconds = seconds;
    this.state.nextBeatTime = new Date(Date.now() + seconds * 1000).toISOString();
    this.state.emit('schedule', { seconds, nextBeat: this.state.nextBeatTime, phase: this.state.phase });

    this._timer = setTimeout(async () => {
      if (!this.state.running) return;
      if (this.state.paused) {
        this.state.emit('agent_log', { message: 'Beat skipped (paused)', level: 'info' });
        this._scheduleNext();
        return;
      }
      await this._beat();
      this._scheduleNext();
    }, seconds * 1000);
  }

  async _beat() {
    if (this._beating) return;
    this._beating = true;

    const beatNum = ++this.state.beatCount;
    this.state.stats.totalBeats = beatNum;
    this.state.lastBeatTime = new Date().toISOString();
    const phase = getCurrentPhase();
    this.state.phase = phase;
    const model = this.state.activeModel;

    this.state.emit('beat_start', { beat: beatNum, phase, time: this.state.lastBeatTime });
    this.state.emit('agent_log', {
      message: `--- Heartbeat #${beatNum} | ${PHASE_DEFAULTS[phase].label} ---`,
      level: 'info',
    });

    // Build permissions context for the prompt
    const perms = getPermissions();
    const permLines = [];
    if (!perms.allowLiveTrading) permLines.push('READ-ONLY MODE: Do NOT place any orders. Analysis and monitoring only.');
    if (!perms.allowOptions) permLines.push('Options trading is DISABLED.');
    if (!perms.allowStocks) permLines.push('Stock trading is DISABLED.');
    if (!perms.allow0DTE) permLines.push('0DTE options are NOT allowed.');
    if (perms.maxPositionPct) permLines.push(`Max position size: ${perms.maxPositionPct}% of portfolio.`);
    if (perms.maxDeployedPct) permLines.push(`Max deployed capital: ${perms.maxDeployedPct}%.`);
    if (perms.maxDailyLoss) permLines.push(`Max daily loss: ${perms.maxDailyLoss}% — auto-pause if exceeded.`);
    if (perms.maxOpenPositions) permLines.push(`Max open positions: ${perms.maxOpenPositions}.`);
    if (perms.maxOrderValue > 0) permLines.push(`Max single order value: $${perms.maxOrderValue}.`);
    if (perms.blockedTools?.length) permLines.push(`Blocked tools (do NOT call): ${perms.blockedTools.join(', ')}.`);
    const permStr = permLines.length ? '\n\nGUARDRAILS:\n' + permLines.join('\n') : '';

    const prompt = `[HEARTBEAT #${beatNum}] Phase: ${PHASE_DEFAULTS[phase].label}. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Current heartbeat interval: ${this.state.heartbeatSeconds}s.${permStr}\n\nPerform your duties for this phase.`;

    try {
      const result = await this._runClaude(prompt, model);
      if (result.error) {
        throw new Error(result.error);
      }
      // Text already streamed via _handleOpenCodeEvent agent_text events
      if (result.toolCalls) this.state.stats.toolCalls += result.toolCalls;

      // Save session ID for continuation
      if (result.sessionId) this._sessionId = result.sessionId;

    } catch (err) {
      this.state.stats.errors++;
      this.state.emit('agent_log', { message: `Beat #${beatNum} error: ${err.message}`, level: 'error' });
      console.error(`Beat #${beatNum} error:`, err);
    }

    this.state.emit('beat_end', { beat: beatNum, phase });
    this._beating = false;
  }

  /**
   * Run opencode as subprocess with MCP tools and stream JSON events
   */
  _runClaude(prompt, model) {
    return new Promise((resolve, reject) => {
      // OpenCode model format: anthropic/claude-sonnet-4-6
      const ocModel = model?.startsWith('anthropic/') ? model : `anthropic/${model || 'claude-sonnet-4-6'}`;

      // Check max tool rounds from permissions
      const perms = getPermissions();
      const maxToolRounds = perms.maxToolRoundsPerBeat || 25;

      const args = [
        'run',
        '--format', 'json',
        '--model', ocModel,
        '--max-turns', String(maxToolRounds),
      ];

      // Continue session if we have one
      if (this._sessionId) {
        args.push('--session', this._sessionId);
      }

      // Only include system prompt on first beat (new session) — subsequent beats
      // on the same session already have it in context, saving ~2000 tokens/beat
      const isNewSession = !this._sessionId;
      const fullPrompt = isNewSession
        ? `[SYSTEM INSTRUCTIONS - Follow these at all times]\n${this.systemPrompt}\n\n[END SYSTEM INSTRUCTIONS]\n\n${prompt}`
        : prompt;

      this.state.emit('agent_log', {
        message: `Spawning opencode (${ocModel})...`,
        level: 'info',
      });

      const proc = spawn('opencode', args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Store reference so sendMessage() can kill it for interrupts
      this._proc = proc;
      this._interrupted = false;

      // Write prompt via stdin then close it
      proc.stdin.on('error', (err) => {
        this.state.emit('agent_log', { message: `stdin error: ${err.message}`, level: 'error' });
      });
      proc.stdin.write(fullPrompt);
      proc.stdin.end();

      let fullText = '';
      let toolCalls = 0;
      let sessionId = null;
      let buffer = '';
      let totalCost = 0;
      let totalTokens = 0;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            this._handleOpenCodeEvent(event, {
              addToolCall: () => toolCalls++,
              addText: (t) => { fullText += t; },
              setSession: (id) => { sessionId = id; },
              addCost: (c) => { totalCost += c; },
              addTokens: (t) => { totalTokens += t; },
            });
          } catch { /* skip unparseable lines */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          this.state.emit('agent_log', { message: `[opencode] ${msg}`, level: 'info' });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn opencode: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        // Clear proc reference and cancel safety timeout
        this._proc = null;
        if (this._beatTimeout) { clearTimeout(this._beatTimeout); this._beatTimeout = null; }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            this._handleOpenCodeEvent(event, {
              addToolCall: () => toolCalls++,
              addText: (t) => { fullText += t; },
              setSession: (id) => { sessionId = id; },
              addCost: (c) => { totalCost += c; },
              addTokens: (t) => { totalTokens += t; },
            });
          } catch {}
        }

        if (totalCost > 0) {
          this.state.emit('agent_log', {
            message: `Beat cost: $${totalCost.toFixed(4)} | Tokens: ${totalTokens}`,
            level: 'info',
          });
        }

        // If we were interrupted by a user message, resolve gracefully
        if (this._interrupted) {
          this.state.emit('agent_log', {
            message: `Beat interrupted by user (collected ${fullText.length} chars, ${toolCalls} tools before interrupt)`,
            level: 'warning',
          });
          resolve({ text: fullText, toolCalls, sessionId, interrupted: true });
          return;
        }

        this.state.emit('agent_log', {
          message: `opencode exited (code: ${code}, signal: ${signal}, text: ${fullText.length} chars, tools: ${toolCalls})`,
          level: code === 0 ? 'info' : 'warning',
        });

        if (code !== 0 && code !== null && !fullText) {
          resolve({ error: `opencode exited with code ${code} signal ${signal}`, text: fullText, toolCalls, sessionId });
        } else if (signal && !fullText) {
          resolve({ error: `opencode killed by ${signal}`, text: fullText, toolCalls, sessionId });
        } else {
          resolve({ text: fullText, toolCalls, sessionId });
        }
      });

      // Safety timeout - 5 minutes max per beat
      this._beatTimeout = setTimeout(() => {
        if (proc && !proc.killed) {
          this.state.emit('agent_log', { message: 'Beat timed out (5 min max), killing process.', level: 'warning' });
          proc.kill('SIGTERM');
        }
      }, 300000);
    });
  }

  /**
   * Handle OpenCode JSON stream events:
   *   step_start  - new LLM turn
   *   text        - assistant text output
   *   tool_use    - tool call with input/output already resolved
   *   step_finish - turn complete with cost/token info
   */
  _handleOpenCodeEvent(event, ctx) {
    const beatNum = this.state.beatCount;

    // Capture session ID from any event
    if (event.sessionID && !this._sessionId) {
      ctx.setSession(event.sessionID);
    }

    switch (event.type) {
      case 'text': {
        const text = event.part?.text;
        if (text?.trim()) {
          ctx.addText(text);
          this.state.emit('agent_text', { text, beat: beatNum });
        }
        break;
      }

      case 'tool_use': {
        const part = event.part || {};
        const toolName = (part.tool || '??').replace('prophet_', ''); // strip MCP prefix for display
        const toolInput = part.state?.input || {};
        const toolOutput = part.state?.output || '';
        const fullToolName = part.tool || toolName;

        ctx.addToolCall();
        this.state.stats.toolCalls++;

        // Emit tool call event
        this.state.emit('tool_call', { name: toolName, args: toolInput, beat: beatNum });

        // Emit tool result
        const resultStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        this.state.emit('tool_result', { name: toolName, result: resultStr.substring(0, 500), beat: beatNum });

        // Track trades
        if (fullToolName.includes('buy') || fullToolName.includes('sell') || fullToolName.includes('order') || fullToolName.includes('managed')) {
          this.state.stats.trades++;
          this.state.addTrade({
            type: 'order',
            tool: toolName,
            symbol: toolInput.symbol || '??',
            side: toolInput.side || (fullToolName.includes('buy') ? 'buy' : 'sell'),
            quantity: toolInput.quantity || toolInput.qty,
            price: toolInput.limit_price,
          });
        }
        break;
      }

      case 'step_finish': {
        const part = event.part || {};
        if (part.cost) ctx.addCost(part.cost);
        if (part.tokens?.total) ctx.addTokens(part.tokens.total);
        break;
      }

      case 'step_start':
        // Just informational, nothing to do
        break;
    }
  }
}
