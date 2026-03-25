# Repository Guidelines

## Project Structure & Module Organization
OpenProphet is split across Node.js orchestration and a Go trading backend.
- `agent/`: dashboard server, heartbeat harness, orchestration, and static UI (`agent/public/`).
- `cmd/bot/main.go`: Go service entrypoint.
- `controllers/`, `services/`, `models/`, `interfaces/`, `database/`: API handlers, business logic, data models, shared types, and persistence.
- `mcp-server.js`: MCP tool server used by AI runtimes.
- `config/`, `seed_data/`, `activity_logs/`, `decisive_actions/`: runtime config and generated operational data.
- `TRADING_RULES.md`: strategy rules injected into agent behavior.

## Build, Test, and Development Commands
- `npm install`: install Node dependencies.
- `npm run agent`: start the dashboard + agent server (default `:3737`), which manages the Go backend lifecycle.
- `npm start`: run MCP server only (`node mcp-server.js`).
- `go build -o prophet_bot ./cmd/bot`: build Go trading backend binary.
- `go run ./cmd/bot`: run backend directly for backend-only debugging.
- `go test ./...`: run Go tests (add tests as you touch Go packages).

## Coding Style & Naming Conventions
- Go: use standard `gofmt` formatting (tabs, idiomatic Go naming); exported identifiers use `PascalCase`, internal helpers use `camelCase`.
- JavaScript (ES modules): 2-space indentation, semicolons, `camelCase` for variables/functions, `PascalCase` for classes.
- Keep files focused by domain (controllers call services; avoid business logic inside route wiring).
- Name new files by responsibility, e.g. `risk_controller.go`, `position_manager.go`.

## Testing Guidelines
- Primary test framework is Go’s built-in `testing` package.
- Place tests alongside code as `*_test.go` (example: `services/technical_analysis_test.go`).
- Prefer table-driven tests for service logic and controller behavior.
- There is no working Node test suite yet (`npm test` is a placeholder); rely on focused Go tests plus manual dashboard/MCP verification.

## Commit & Pull Request Guidelines
- Follow existing history style: short, imperative, lowercase summaries (example: `update mcp config path`).
- Keep commits scoped to one logical change.
- PRs should include:
  - What changed and why.
  - Any config/env updates (`.env.example`, ports, tokens).
  - Manual verification steps (commands run, endpoints/UI flows checked).
  - Screenshots/GIFs for dashboard UI changes.
