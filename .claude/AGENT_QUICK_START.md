# Agent Quick Start Guide

## For All Agents: Essential Commands

### Check Account Status
```
mcp__prophet__get_account()
```
Returns: Cash, portfolio value, buying power, day trade count

### Get Current Positions
```
mcp__prophet__get_positions()  # All positions
mcp__prophet__get_managed_positions(status="ACTIVE")  # Only managed positions
```

### Get Market Intelligence
```
mcp__prophet__get_quick_market_intelligence()  # Fast market summary
mcp__prophet__analyze_stocks(symbols=["NVDA", "SPY"])  # Deep analysis
```

### Check Market Hours
```
mcp__prophet__get_datetime()
```
Returns: Time, market status (OPEN/CLOSED/PRE_MARKET/AFTER_HOURS)

### Log Your Activities
```
mcp__prophet__log_decision(action="BUY", symbol="SPY", reasoning="...")
mcp__prophet__log_activity(type="ANALYSIS", action="Analyzed 5 stocks", reasoning="...")
```

---

## For Stratagem (Options Scalper)

### Find Option Contracts
```
mcp__prophet__get_options_chain(
    symbol="SPY",
    type="call",
    delta_min=0.30,
    delta_max=0.45,
    min_bid=0.5
)
```

### Place Options Order
```
mcp__prophet__place_options_order(
    symbol="SPY251219C00680000",  # OCC format
    underlying="SPY",
    quantity=5,
    side="buy",
    order_type="limit",
    limit_price=2.50
)
```

### Learn from Past Trades
```
mcp__prophet__find_similar_setups(
    query="SPY call breakout momentum scalp",
    limit=5,
    strategy="SCALP"
)
```

### Record Trade After Close
```
mcp__prophet__store_trade_setup(
    symbol="SPY",
    action="BUY",
    strategy="SCALP",
    result_pct=26.5,
    result_dollars=1920,
    reasoning="Clean breakout above VWAP with volume surge...",
    market_context="Market in strong uptrend, VIX falling..."
)
```

---

## For Paragon (CEO)

### Monitor All Positions
```
mcp__prophet__get_managed_positions(status="ALL")  # See everything
mcp__prophet__get_positions()  # Raw positions
```

### Review Performance Stats
```
mcp__prophet__get_trade_stats()  # All trades
mcp__prophet__get_trade_stats(strategy="SCALP")  # By strategy
mcp__prophet__get_trade_stats(symbol="SPY")  # By symbol
```

### View Activity Log
```
mcp__prophet__get_activity_log()  # Today's activities
```

### Close Underperforming Positions
```
mcp__prophet__close_managed_position(position_id="pos_12345")
```

---

## For Forge (Go Engineer)

You primarily work with Go code. When agents request infrastructure:

### Running Go Code
```bash
# Allowed via permissions
Bash(go run:*)
Bash(go build:*)
Bash(go mod init:*)
Bash(go get:*)
```

### Starting the Trading Bot
```bash
ALPACA_API_KEY=<key> ALPACA_SECRET_KEY=<secret> go run ./cmd/bot/main.go
```

### Key Go Files
- `cmd/bot/main.go` - Main entry point
- `services/` - Core trading services
- `controllers/` - HTTP API handlers
- `models/` - Data structures
- `database/` - SQLite storage
- `interfaces/` - Service contracts

---

## For Daedalus (Intelligence Director)

### Audit Decision Quality
Review agent decisions via:
```
mcp__prophet__get_activity_log()
```

### Pressure-Test Strategies
```
mcp__prophet__get_trade_stats(strategy="SCALP")
mcp__prophet__find_similar_setups(query="...", ...)
```

### Evaluate Market Conditions
```
mcp__prophet__get_quick_market_intelligence()
mcp__prophet__analyze_stocks(symbols=[...])
```

---

## Common Workflows

### Before Making a Trade

1. Check market hours: `get_datetime()`
2. Get current account status: `get_account()`
3. Analyze the stock: `analyze_stocks(symbols=["XYZ"])`
4. Find similar past setups: `find_similar_setups(query="XYZ momentum...")`
5. If options: Get chain: `get_options_chain(symbol="XYZ", ...)`
6. Execute trade (managed position preferred)
7. Log decision: `log_decision(action="BUY", reasoning="...")`

### For Managed Positions

1. Define risk parameters (stop loss %, take profit %)
2. Place managed position: `place_managed_position(...)`
3. Position manager handles:
   - Entry order
   - Stop-loss order (trailing if configured)
   - Take-profit order
   - Partial exits if configured
   - Status tracking (PENDING → ACTIVE → PARTIAL → CLOSED/STOPPED_OUT)

### After Closing a Trade

1. Record in trade database: `store_trade_setup(...)`
2. Log outcome: `log_activity(type="POSITION_CHECK", ...)`
3. Review stats: `get_trade_stats(...)`

---

## Permissions (Pre-Approved)

All agents have auto-approval for:
- All `mcp__prophet__*` tools
- `WebSearch`
- Basic Bash: `mkdir`, `go run`, `python3`, `node`, `cat`, etc.

No approval needed for read-only operations or standard trading actions.

---

## Important Reminders

1. **Paper Trading** - Currently connected to Alpaca paper account
2. **No Backtesting** - System is live-only, all backtesting code removed
3. **Managed Positions Preferred** - Built-in risk management
4. **Always Log Decisions** - Audit trail is critical
5. **Check Market Hours** - Don't place orders when market is closed
6. **Learn from History** - Use `find_similar_setups` before new trades
7. **Respect Capital** - Portfolio is ~$107K, use proper position sizing

---

## Getting Help

- **System Architecture**: See `.claude/SYSTEM_ARCHITECTURE.md`
- **MCP Tools**: All tools documented in system architecture
- **Go Code**: Navigate to `services/`, `controllers/`, `models/`
- **Logs**: Check `activity_logs/` directory
