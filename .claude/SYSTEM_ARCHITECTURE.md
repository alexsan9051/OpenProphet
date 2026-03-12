# Prophet Trader System Architecture

## Overview
Prophet Trader is a live options and equities trading system that integrates Claude AI agents with a Go backend trading engine and Alpaca Markets API.

## System Components

### 1. MCP Server (Node.js)
**File**: `mcp-server.js`

The Model Context Protocol server provides Claude agents with access to all trading functionality through tool calls. This is the **primary interface** for all agent interactions.

**Available Tools**:
- Account & Position Management: `get_account`, `get_positions`, `get_managed_positions`
- Trading: `place_buy_order`, `place_sell_order`, `place_options_order`, `place_managed_position`
- Market Data: `get_quote`, `get_latest_bar`, `get_historical_bars`, `get_options_chain`
- News & Intelligence: `get_quick_market_intelligence`, `analyze_stocks`, `search_news`
- Activity Logging: `log_decision`, `log_activity`, `get_activity_log`
- Options: `get_options_positions`, `get_options_position`, `get_options_chain`
- Utilities: `wait`, `get_datetime`
- Trade History: `find_similar_setups`, `store_trade_setup`, `get_trade_stats`

### 2. Go Trading Bot
**Entry Point**: `cmd/bot/main.go`
**Port**: 4534
**API Base**: `http://localhost:4534/api/v1`

The Go backend provides:
- Real-time connection to Alpaca Markets (paper trading)
- Position monitoring and management
- Managed position lifecycle (entry, stop-loss, take-profit, trailing stops)
- Market data retrieval
- News aggregation (Google News, MarketWatch)
- AI-powered stock analysis (Gemini integration)
- Activity logging and trade journaling

**Key Services**:
- `services/alpaca_trading.go` - Live trading execution
- `services/alpaca_data.go` - Market data
- `services/position_manager.go` - Managed position automation
- `services/news_service.go` - News aggregation
- `services/gemini_service.go` - AI analysis
- `services/stock_analysis_service.go` - Multi-stock technical analysis
- `services/activity_logger.go` - Trade journaling

### 3. Database
**Type**: SQLite
**Path**: `data/prophet_trader.db`

Stores:
- Managed positions with full lifecycle tracking
- Position snapshots (every 5 minutes)
- Account snapshots
- Activity logs
- Trade history

### 4. Vector Database
**Type**: ChromaDB (via vectorDB.js)

Stores trade setups with AI embeddings for similarity search:
- Historical trade reasoning
- Market context
- Results (P&L %, dollars)
- Strategy classification
- Used for finding similar past trades to inform current decisions

## Trading Capabilities

### Live Trading (Supported)
- ✅ Market and limit orders for stocks
- ✅ Long call and put options (monthly expirations)
- ✅ Managed positions with auto stop-loss, take-profit, trailing stops
- ✅ Position monitoring and automated risk management
- ✅ Real-time market data and quotes
- ✅ Options chain analysis with delta/IV filtering

### NOT Supported (Removed)
- ❌ Backtesting (all backtesting code removed)
- ❌ Strategy development/testing frameworks
- ❌ Historical options data analysis
- ❌ Multi-leg option strategies (spreads, iron condors, etc.)

## Agent Execution Flow

1. **Agent Decision** → Claude agent uses MCP tools to gather market data
2. **MCP Server** → Proxies request to Go trading bot API
3. **Go Trading Bot** → Executes via Alpaca API or returns data
4. **Response** → Data flows back: Go → MCP → Claude Agent
5. **Logging** → Agent logs decision reasoning and trades

## Key MCP Tools by Use Case

### For Market Analysis
```
mcp__prophet__get_quote(symbol)
mcp__prophet__get_latest_bar(symbol)
mcp__prophet__get_historical_bars(symbol, start_date, end_date)
mcp__prophet__analyze_stocks(symbols)
mcp__prophet__get_quick_market_intelligence()
```

### For Options Trading
```
mcp__prophet__get_options_chain(symbol, expiration, delta_min, delta_max, type)
mcp__prophet__place_options_order(symbol, quantity, side, order_type, limit_price)
mcp__prophet__get_options_positions()
```

### For Position Management
```
mcp__prophet__place_managed_position(symbol, side, allocation_dollars, stop_loss_percent, take_profit_percent)
mcp__prophet__get_managed_positions(status)
mcp__prophet__close_managed_position(position_id)
```

### For Learning from History
```
mcp__prophet__find_similar_setups(query, limit, symbol, strategy)
mcp__prophet__store_trade_setup(symbol, action, strategy, result_pct, reasoning, market_context)
mcp__prophet__get_trade_stats(symbol, strategy, action)
```

## Environment Variables
**File**: `.env`

Required:
- `ALPACA_API_KEY` - Alpaca API key
- `ALPACA_SECRET_KEY` - Alpaca secret key
- `GEMINI_API_KEY` - Google Gemini API key for AI analysis

Optional:
- `ALPACA_BASE_URL` - Defaults to paper trading
- `DATABASE_PATH` - Defaults to `./data/prophet_trader.db`
- `SERVER_PORT` - Defaults to 4534

## Agent Responsibilities

### Paragon (CEO)
- Capital allocation across strategies
- Risk management and drawdown control
- Performance oversight
- Hiring/firing other agents

### Stratagem (Options Scalper)
- Identifies short-term directional option trades
- Uses monthly options (21-45 DTE)
- Delta 0.30-0.45, tight spreads
- 1.5:1 minimum R:R, max 1.5% risk per trade

### Forge (Go Engineer)
- Builds Go infrastructure when requested
- Does NOT act autonomously
- Only responds to direct requests from other agents

### Daedalus (Intelligence Director)
- Pressure-tests strategic decisions
- Identifies unseen risks and flawed assumptions
- Resolves conflicts between agents
- Recommends agent hiring/firing

## Current Account Status
- Portfolio Value: ~$107K
- Cash: ~$66K
- Buying Power: ~$389K (margin available)
- Pattern Day Trader: Yes (40+ day trades)

## Starting the System

```bash
# Start Go trading bot
ALPACA_API_KEY=<key> ALPACA_SECRET_KEY=<secret> go run ./cmd/bot/main.go

# MCP server is auto-configured in Claude Code
# No manual start needed - it spawns on demand
```

## Important Notes for Agents

1. **All trading must go through MCP tools** - Never try to execute trades via bash/curl
2. **Managed positions are preferred** - They have built-in risk management
3. **Log all decisions** - Use `log_decision` and `log_activity` for audit trail
4. **Check market hours** - Use `get_datetime` to check if markets are open
5. **No backtesting** - System is live-only, focus on real-time execution
6. **Learn from history** - Use `find_similar_setups` before making new trades
7. **Monitor positions** - Use `get_managed_positions` to track active trades
8. **Paper trading** - Currently connected to Alpaca paper account (not real money)
