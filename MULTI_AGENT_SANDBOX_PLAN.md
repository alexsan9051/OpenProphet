# Multi-Agent Sandbox Plan

## Goal

Make each trading account its own autonomous sandbox with isolated:

- agent prompt and persona
- heartbeat cadence and runtime state
- permissions and risk guardrails
- chat/session memory
- historical chat access
- activity, decisions, and learned trade memory

This fixes the current failure mode where one agent confuses context between multiple accounts because the app still behaves like a single global agent with one shared memory lane.

## Core Problem Today

The current architecture has multi-account credentials, but most agent state is still global:

- one active agent
- one active model
- one heartbeat config
- one permissions block
- one OpenCode session chain
- one Go backend at a time

That means account switching changes credentials, but not true agent isolation.

## Target Model

Each account gets a dedicated sandbox:

`data/sandboxes/<accountId>/`

Each sandbox owns:

- OpenCode session ID(s)
- chat transcripts
- current runtime state
- heartbeat overrides
- permission overrides
- sandbox-local activity and decision logs
- sandbox-local vector memory / learned trade history

Shared global resources remain:

- account credential registry
- reusable agent templates
- reusable strategy templates
- model catalog

## Proposed Config Shape

Top-level config becomes a hybrid of global catalogs plus per-account sandbox state.

```json
{
  "schemaVersion": 2,
  "activeAccountId": "6edbf348",
  "activeSandboxId": "sbx_6edbf348",
  "accounts": [],
  "agents": [],
  "strategies": [],
  "models": [],
  "sandboxes": {
    "sbx_6edbf348": {
      "id": "sbx_6edbf348",
      "accountId": "6edbf348",
      "name": "Paper",
      "agent": {
        "activeAgentId": "default",
        "model": "anthropic/claude-sonnet-4-6"
      },
      "heartbeat": {},
      "permissions": {},
      "plugins": {},
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
```

## Isolation Boundaries

### 1. Account Sandbox

Each sandbox should own:

- one `AgentHarness` instance
- one Go trading backend process on its own port
- one OpenCode session thread
- one SSE stream namespace
- one persistent chat history index

### 2. Prompt and Strategy Isolation

Prompt changes should affect only the sandbox that issued them.

- `update_agent_prompt` updates the active sandbox's selected agent behavior
- `update_strategy_rules` should support sandbox override or shared global template edits
- heartbeat overrides stay local to that sandbox

### 3. Memory Isolation

Chat memory and trading memory should be separate by default.

- chat history: `data/sandboxes/<accountId>/chat-history/`
- decisions: `data/sandboxes/<accountId>/decisive_actions/`
- activity: `data/sandboxes/<accountId>/activity_logs/`
- vector memory: `data/sandboxes/<accountId>/prophet_trader.db` or namespaced tables

## Chat History

We should support old chat access by persisting OpenCode sessions externally.

### Storage

- append-only `jsonl` session files
- session index file per sandbox
- message roles: `user`, `assistant`, `system`, `tool_call`, `tool_result`

### Minimum API

- list sessions for an account
- get one session transcript
- search sessions later
- continue a prior session explicitly if desired

## Orchestration Plan

### Phase 1: Config Foundation

- add sandbox-aware config store
- migrate legacy single-agent config into per-account sandboxes
- keep backward-compatible getters so current routes still work

### Phase 2: Runtime Orchestrator

- create `AgentOrchestrator`
- manage one harness per sandbox
- manage one Go backend per sandbox
- allow independent start/stop/pause per sandbox

### Phase 3: Harness Refactor

- make `AgentHarness` constructor accept sandbox config and runtime services
- stop reading global active account/agent state directly
- attach chat persistence hooks

### Phase 4: API and MCP Refactor

- add sandbox-scoped routes
- route permission checks through sandbox context
- route prompt/strategy/heartbeat updates through sandbox context

### Phase 5: UI

- sandbox switcher
- per-account terminal streams
- chat history browser
- old session transcript viewer

## Migration Strategy

For existing installs:

1. keep the current `accounts`, `agents`, `strategies`, `models`
2. create a sandbox for every existing account
3. copy legacy global `activeAgentId`, `activeModel`, `heartbeat`, `permissions`, and `plugins` into each new sandbox
4. set `activeSandboxId` from `activeAccountId`
5. keep legacy top-level fields as compatibility aliases during transition

## Implementation Notes

- use object lookup for `sandboxes` keyed by sandbox id
- preserve current public config-store API where possible
- prefer additive migration first, then deeper runtime split
- keep MCP tool semantics unchanged where possible; inject sandbox context via environment or route params

## Success Criteria

We know this works when:

- two accounts can run simultaneously without context bleed
- each account has distinct heartbeat cadence and prompt
- switching accounts no longer reuses the wrong conversation memory
- old chats can be listed and reopened by account
- decisions and activity logs clearly belong to one sandbox
