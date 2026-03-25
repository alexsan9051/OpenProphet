# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This?

OpenProphet is an autonomous AI-powered trading system. Claude agents run on a heartbeat loop, use MCP tools to analyze markets, and execute options/equity trades via Alpaca Markets. Currently connected to a **paper trading account** (not real money).

## Starting the System

```bash
# Start the full agent dashboard (Node.js) — also manages Go backend lifecycle
npm run agent

# Or start ONLY the MCP server (for use with OpenCode/Claude Code directly)
npm start

# Build Go backend manually (agent server auto-builds it)
go build -o prophet-trader ./cmd/bot/main.go
```

The agent dashboard runs on port **3737**. The Go trading backend runs on port **4534**.

## Architecture

```
Web Dashboard (port 3737)
    └── Agent Server (agent/server.js) — Express, SSE streaming, config store
            ├── Heartbeat Loop (agent/harness.js) — spawns AI runner subprocesses (OpenCode/Claude Code/Codex)
            │       └── MCP Server (mcp-server.js) — 45+ tools, stdio transport
            │               └── Go Trading Bot (port 4534) — REST API
            │                       └── Alpaca Markets API
            └── Go Backend lifecycle (auto-build and restart)
```

**Execution flow per heartbeat:**
1. Harness wakes on schedule (2m during market hours, up to 1h when closed)
2. Spawns AI runner subprocess (OpenCode by default, or Claude Code / Codex)
3. Runner loads MCP server, AI calls trading tools
4. MCP proxies calls to Go backend → Alpaca API
5. Results stream back to dashboard via SSE

## Key Files

| File | Purpose |
|------|---------|
| `mcp-server.js` | All MCP tool definitions and HTTP proxy logic (2200+ LOC) |
| `agent/server.js` | Express dashboard server, REST API, SSE, Go process management |
| `agent/harness.js` | Heartbeat orchestrator, session persistence, AI runner subprocess routing |
| `agent/config-store.js` | Persistent JSON config (heartbeat phases, permissions, accounts) |
| `cmd/bot/main.go` | Go backend entry point |
| `services/position_manager.go` | Managed position automation (stop-loss, take-profit, trailing) |
| `TRADING_RULES.md` | Injected into agent system prompt on every session |
| `.claude/SYSTEM_ARCHITECTURE.md` | Detailed component documentation for agents |

## Environment Variables

```bash
# Required
ALPACA_ENDPOINT=https://paper-api.alpaca.markets
ALPACA_PUBLIC_KEY=your_key
ALPACA_SECRET_KEY=your_secret

# Optional
GEMINI_API_KEY=your_key          # AI-powered news cleaning
AGENT_PORT=3737
TRADING_BOT_PORT=4534
TRADING_BOT_URL=http://localhost:4534
AGENT_AUTH_TOKEN=                # Auth for dashboard API
```

## MCP Tool Categories

All trading must go through MCP tools — never via bash/curl directly.

- **Account/Positions**: `get_account`, `get_positions`, `get_managed_positions`
- **Trading**: `place_buy_order`, `place_sell_order`, `place_options_order`, `place_managed_position`
- **Market Data**: `get_quote`, `get_latest_bar`, `get_historical_bars`, `get_options_chain`
- **Intelligence**: `get_quick_market_intelligence`, `analyze_stocks`, `search_news`
- **Logging**: `log_decision`, `log_activity`, `get_activity_log`
- **Vector Search**: `find_similar_setups`, `store_trade_setup`, `get_trade_stats`
- **Utilities**: `wait`, `get_datetime`

## Go Backend

- REST API base: `http://localhost:4534/api/v1`
- Framework: Gin
- ORM: GORM + SQLite (`data/prophet_trader.db`)
- Multi-account: database isolated per account at `data/sandboxes/{accountId}/prophet_trader.db`

When adding new trading capabilities, add a Go controller/service, then expose it via a new MCP tool in `mcp-server.js`.

## Permission System

`mcp-server.js` enforces permissions before every tool execution via `enforcePermissions()`:
- `blockedTools` — tools the agent cannot call
- `allowLiveTrading` / `allowOptions` / `allow0DTE` — trading gates
- `maxOrderValue` — per-order cap
- `maxDailyLoss` — circuit breaker (auto-pauses agent)
- `requireConfirmation` — tools requiring human approval
- `maxToolRoundsPerBeat` — limits tool calls per heartbeat

## Agent Personas (Subagents)

Defined in `.claude/agents/` and configured in Claude Code settings:
- **paragon-trading-ceo** — capital allocation, risk management, portfolio oversight
- **stratagem-options-scalper** — short-term directional options trades
- **forge-go-engineer** — builds Go infrastructure on request only (not autonomous)
- **daedalus-intelligence-director** — pressure-tests decisions, identifies risks

## Runner Options

The heartbeat agent can use three different AI runners, selected per-sandbox via `runnerType` in `data/agent-config.json`:

| Runner | `runnerType` | Command | Cost | Session |
|--------|-------------|---------|------|---------|
| OpenCode | `opencode` (default) | `opencode run` | Per-token | Persistent across beats |
| Claude Code | `claude-code` | `claude --print` | Included in Claude Pro/Max | Persistent across beats |
| Codex | `codex` | `codex exec` | Included in ChatGPT Plus | Fresh each beat |

**To switch to Claude Code (no extra cost with Claude Pro):**
1. Log in: `claude login`
2. Set `runnerType: "claude-code"` on the sandbox in `data/agent-config.json`, or via dashboard
3. Set the agent model to an `anthropic/` model (e.g. `anthropic/claude-sonnet-4-6`)

**To switch to Codex (no extra cost with ChatGPT Plus):**
1. Log in: `codex login`
2. Set `runnerType: "codex"` on the sandbox
3. Set the agent model to an `openai/` model (e.g. `openai/gpt-5.4`)
4. Note: Codex does not preserve context across beats (no session continuation)

**MCP config files** (required for each runner's tool access):
- Claude Code: `.mcp.json` (auto-detected in project root)
- Codex: `.codex/config.toml`
- OpenCode: `opencode.jsonc` (copy from `opencode.example.jsonc`)

## Trading Rules Summary

Full rules in `TRADING_RULES.md`. Key constraints:
- Options-only, long calls preferred, occasional puts for hedging
- Max 15% portfolio per position, max 10 simultaneous positions
- Limit orders only on options (never market orders)
- Cut losers at -15% or when thesis breaks; take profits at +25-50%
- Hard stop: cease trading if daily portfolio loss hits -5%
- Preferred DTE: 50-120 for swings, 2-5 for scalps
- Always log decisions via `log_decision` and `log_activity` MCP tools
