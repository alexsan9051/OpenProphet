// Persistent configuration store for accounts, agents, strategies, and prompts
// Uses a JSON file for simplicity - no extra DB dependencies
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'agent-config.json');

const DEFAULT_CONFIG = {
  // Active selections
  activeAccountId: null,
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',

  // Heartbeat phase intervals (seconds)
  heartbeat: {
    pre_market: 900,
    market_open: 120,
    midday: 600,
    market_close: 120,
    after_hours: 1800,
    closed: 3600,
  },

  // Agent permissions / guardrails
  permissions: {
    allowLiveTrading: true,        // false = read-only mode (analysis only, no orders)
    maxPositionPct: 15,            // max % of portfolio per position
    maxDeployedPct: 80,            // max % of portfolio deployed at once
    maxDailyLoss: 5,               // max daily loss % before agent auto-pauses
    maxOpenPositions: 10,          // max number of simultaneous positions
    maxOrderValue: 0,              // max single order value in $, 0 = unlimited
    allowedTools: [],              // empty = all tools allowed; otherwise whitelist
    blockedTools: [],              // tools explicitly blocked
    allowOptions: true,            // allow options trading
    allowStocks: true,             // allow stock trading
    allow0DTE: false,              // allow 0DTE options
    requireConfirmation: false,    // pause and wait for manual confirm before orders
    maxToolRoundsPerBeat: 25,      // max tool calls per heartbeat
  },

  // Plugins
  plugins: {
    slack: {
      enabled: false,
      webhookUrl: '',              // Slack incoming webhook URL
      channel: '',                 // override channel (optional)
      notifyOn: {
        tradeExecuted: true,       // notify on trade execution
        agentStartStop: true,      // notify on agent start/stop
        errors: true,              // notify on errors
        dailySummary: true,        // daily P&L summary
        positionOpened: true,      // new position opened
        positionClosed: true,      // position closed
        heartbeat: false,          // every heartbeat (noisy)
      },
    },
  },

  // Alpaca trading accounts
  accounts: [],

  // Agent personas
  agents: [
    {
      id: 'default',
      name: 'Prophet',
      description: 'Aggressive discretionary options trader with scalping overlay',
      systemPromptTemplate: 'default', // uses built-in prompt
      strategyId: 'default',
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {},
      createdAt: new Date().toISOString(),
    },
    {
      id: 'conservative',
      name: 'Guardian',
      description: 'Conservative swing trader focused on capital preservation',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are Guardian, a conservative AI trading agent. You prioritize capital preservation above all else.

## Rules
- Only take high-conviction setups with clear risk/reward > 3:1
- Maximum 5% of portfolio per position
- Maximum 30% deployed at any time (70%+ cash always)
- Only swing trades: 30-90 DTE, delta 0.40-0.60
- No scalping, no 0DTE, no earnings plays
- Stop loss at -10%, take profit at +30%
- Maximum 5 positions at once`,
      strategyId: null,
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 1800,
        market_open: 300,
        midday: 900,
        market_close: 300,
        after_hours: 3600,
      },
      createdAt: new Date().toISOString(),
    },
  ],

  // Trading strategies (editable rule sets)
  strategies: [
    {
      id: 'default',
      name: 'Aggressive Options',
      description: 'Multi-timeframe options with scalping overlay',
      rulesFile: 'TRADING_RULES.md', // loads from file
      customRules: null,
      createdAt: new Date().toISOString(),
    },
  ],

  // Available models (OpenCode format: anthropic/<model>)
  models: [
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Best speed + intelligence, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most intelligent, best for agents, $5/$25 per MTok' },
    { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fastest, near-frontier, $1/$5 per MTok' },
    { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Legacy)', description: 'Previous gen Sonnet, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5 (Legacy)', description: 'Previous gen Opus, $5/$25 per MTok' },
    { id: 'anthropic/claude-sonnet-4-0', name: 'Claude Sonnet 4 (Legacy)', description: 'Original Sonnet 4, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-0', name: 'Claude Opus 4 (Legacy)', description: 'Original Opus 4, $15/$75 per MTok' },
  ],
};

let _config = null;
let _writeLock = Promise.resolve();

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    _config = JSON.parse(raw);
    // Deep-merge with defaults for new nested fields
    _config = {
      ...DEFAULT_CONFIG,
      ..._config,
      heartbeat: { ...DEFAULT_CONFIG.heartbeat, ...(_config.heartbeat || {}) },
      permissions: { ...DEFAULT_CONFIG.permissions, ...(_config.permissions || {}) },
      plugins: {
        ...DEFAULT_CONFIG.plugins,
        ...(_config.plugins || {}),
        slack: {
          ...DEFAULT_CONFIG.plugins.slack,
          ...(_config.plugins?.slack || {}),
          notifyOn: { ...DEFAULT_CONFIG.plugins.slack.notifyOn, ...(_config.plugins?.slack?.notifyOn || {}) },
        },
      },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Warning: Failed to parse config file:', err.message);
    _config = { ...DEFAULT_CONFIG };
  }

  // Auto-import account from env vars if no accounts exist
  if (_config.accounts.length === 0) {
    const pk = process.env.ALPACA_PUBLIC_KEY || process.env.ALPACA_API_KEY;
    const sk = process.env.ALPACA_SECRET_KEY;
    if (pk && sk) {
      const baseUrl = process.env.ALPACA_BASE_URL || process.env.ALPACA_ENDPOINT || '';
      const isPaper = baseUrl.includes('paper') || process.env.ALPACA_PAPER === 'true';
      const id = crypto.randomUUID().slice(0, 8);
      _config.accounts.push({
        id,
        name: isPaper ? 'Paper (from .env)' : 'Live (from .env)',
        publicKey: pk,
        secretKey: sk,
        baseUrl: baseUrl || (isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
        paper: isPaper,
        createdAt: new Date().toISOString(),
      });
      _config.activeAccountId = id;
      console.log(`  Auto-imported Alpaca account from .env (${isPaper ? 'paper' : 'live'})`);
    }
  }

  await saveConfig();
  return _config;
}

export async function saveConfig() {
  // Serialize writes to prevent concurrent clobbering
  _writeLock = _writeLock.then(async () => {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(_config, null, 2));
  }).catch(err => console.error('Config save error:', err.message));
  return _writeLock;
}

export function getConfig() {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

// ── Accounts ───────────────────────────────────────────────────────

export async function addAccount({ name, publicKey, secretKey, baseUrl, paper }) {
  const id = crypto.randomUUID().slice(0, 8);
  const account = {
    id,
    name: name || `Account ${_config.accounts.length + 1}`,
    publicKey,
    secretKey,
    baseUrl: baseUrl || (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    paper: paper !== false,
    createdAt: new Date().toISOString(),
  };
  _config.accounts.push(account);
  if (!_config.activeAccountId) _config.activeAccountId = id;
  await saveConfig();
  return account;
}

export async function removeAccount(id) {
  _config.accounts = _config.accounts.filter(a => a.id !== id);
  if (_config.activeAccountId === id) {
    _config.activeAccountId = _config.accounts[0]?.id || null;
  }
  await saveConfig();
}

export async function setActiveAccount(id) {
  if (!_config.accounts.find(a => a.id === id)) throw new Error('Account not found');
  _config.activeAccountId = id;
  await saveConfig();
}

export function getActiveAccount() {
  return _config.accounts.find(a => a.id === _config.activeAccountId) || null;
}

// ── Agents ─────────────────────────────────────────────────────────

export async function addAgent(agent) {
  const id = crypto.randomUUID().slice(0, 8);
  const newAgent = {
    id,
    name: agent.name || 'New Agent',
    description: agent.description || '',
    systemPromptTemplate: agent.systemPromptTemplate || 'custom',
    customSystemPrompt: agent.customSystemPrompt || '',
    strategyId: agent.strategyId || null,
    model: agent.model || _config.activeModel,
    heartbeatOverrides: agent.heartbeatOverrides || {},
    createdAt: new Date().toISOString(),
  };
  _config.agents.push(newAgent);
  await saveConfig();
  return newAgent;
}

export async function updateAgent(id, updates) {
  const idx = _config.agents.findIndex(a => a.id === id);
  if (idx === -1) throw new Error('Agent not found');
  _config.agents[idx] = { ..._config.agents[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveConfig();
  return _config.agents[idx];
}

export async function removeAgent(id) {
  if (id === 'default') throw new Error('Cannot remove default agent');
  _config.agents = _config.agents.filter(a => a.id !== id);
  if (_config.activeAgentId === id) _config.activeAgentId = 'default';
  await saveConfig();
}

export async function setActiveAgent(id) {
  if (!_config.agents.find(a => a.id === id)) throw new Error('Agent not found');
  _config.activeAgentId = id;
  await saveConfig();
}

export function getActiveAgent() {
  return _config.agents.find(a => a.id === _config.activeAgentId) || _config.agents[0];
}

// ── Strategies ─────────────────────────────────────────────────────

export async function addStrategy(strategy) {
  const id = crypto.randomUUID().slice(0, 8);
  const newStrategy = {
    id,
    name: strategy.name || 'New Strategy',
    description: strategy.description || '',
    rulesFile: null,
    customRules: strategy.customRules || '',
    createdAt: new Date().toISOString(),
  };
  _config.strategies.push(newStrategy);
  await saveConfig();
  return newStrategy;
}

export async function updateStrategy(id, updates) {
  const idx = _config.strategies.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Strategy not found');
  _config.strategies[idx] = { ..._config.strategies[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveConfig();
  return _config.strategies[idx];
}

export async function removeStrategy(id) {
  if (id === 'default') throw new Error('Cannot remove default strategy');
  _config.strategies = _config.strategies.filter(s => s.id !== id);
  await saveConfig();
}

// ── Model ──────────────────────────────────────────────────────────

export async function setActiveModel(modelId) {
  _config.activeModel = modelId;
  await saveConfig();
}

// ── Heartbeat ─────────────────────────────────────────────────────

export async function updateHeartbeat(phaseIntervals) {
  _config.heartbeat = { ..._config.heartbeat, ...phaseIntervals };
  await saveConfig();
}

export function getHeartbeatForPhase(phase) {
  return _config.heartbeat?.[phase] || DEFAULT_CONFIG.heartbeat[phase] || 600;
}

// ── Permissions ───────────────────────────────────────────────────

export async function updatePermissions(perms) {
  _config.permissions = { ..._config.permissions, ...perms };
  await saveConfig();
}

export function getPermissions() {
  return _config.permissions || DEFAULT_CONFIG.permissions;
}

// ── Plugins ───────────────────────────────────────────────────────

export async function updatePlugin(pluginName, pluginConfig) {
  if (!_config.plugins) _config.plugins = {};
  _config.plugins[pluginName] = { ...(_config.plugins[pluginName] || {}), ...pluginConfig };
  await saveConfig();
}

export function getPlugin(pluginName) {
  return _config.plugins?.[pluginName] || null;
}
