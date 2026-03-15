#!/bin/bash

# Prophet Agent Launcher
# Starts the Go trading backend + Node.js agent dashboard

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     OpenProphet Autonomous Agent         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# Load env
if [ -f .env ]; then
    set -a
    source .env
    set +a
else
    echo -e "${RED}No .env file found. Copy .env.example and fill in your keys.${NC}"
    exit 1
fi

# Check for OpenCode auth
if ! opencode auth list 2>/dev/null | grep -q 'Anthropic'; then
    echo -e "${YELLOW}OpenCode not authenticated with Anthropic.${NC}"
    echo -e "${YELLOW}Run 'opencode auth login' or use the Settings tab in the dashboard.${NC}"
fi

# Check/start trading bot
if lsof -Pi :4534 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}[ok] Trading bot running on port 4534${NC}"
else
    echo -e "${YELLOW}Starting Go trading bot...${NC}"

    if [ ! -f ./prophet_bot ]; then
        echo -e "${YELLOW}Building Go binary...${NC}"
        go build -o prophet_bot ./cmd/bot
    fi

    ALPACA_API_KEY=${ALPACA_API_KEY:-$ALPACA_PUBLIC_KEY} \
    ALPACA_SECRET_KEY=${ALPACA_SECRET_KEY} \
    nohup ./prophet_bot > trading_bot.log 2>&1 &
    echo $! > trading_bot.pid
    sleep 3

    if lsof -Pi :4534 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}[ok] Trading bot started (PID: $(cat trading_bot.pid))${NC}"
    else
        echo -e "${RED}[fail] Trading bot failed to start. Check trading_bot.log${NC}"
        exit 1
    fi
fi

echo ""

# Check/start agent dashboard
AGENT_PORT=${AGENT_PORT:-3737}

if lsof -Pi :$AGENT_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}Port $AGENT_PORT already in use. Killing existing process...${NC}"
    kill $(lsof -Pi :$AGENT_PORT -sTCP:LISTEN -t) 2>/dev/null || true
    sleep 1
fi

echo -e "${YELLOW}Starting agent dashboard on port $AGENT_PORT...${NC}"
echo ""

node agent/server.js
