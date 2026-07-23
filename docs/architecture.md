# Ax Brain Crew — Architecture Notes

## Overview

Ax Brain Crew is a local-first TypeScript application that uses AxLLM (`@ax-llm/ax` v21.0.14) as the agent runtime, connected to the CommandCode proxy at `http://127.0.0.1:8787/v1`. It routes natural-language requests to specialist agents (defined in `crew/registry.yaml`) that operate on an Obsidian vault using narrow, safe tools.

## Architecture Diagram

```
CLI (src/cli/main.ts)
  ↓
Dispatacher (src/runtime/dispatcher.ts)
  ↓
Two-Stage Router (src/routing/)
  ├── normalize.ts (deterministic prefix check)
  ├── skill-router.ts (registered skills)
  └── agent-router.ts (Ax-based classification)
  ↓
Executor (src/runtime/executor.ts)
  ↓
Ax Agent (agent() with allowed tools)
  ↓
Vault Tools (src/tools/) ←── path safety at resolveVaultPath()
  ↓
Obsidian Vault (./vault/)
  ↓
Run Record → SQLite (src/persistence/)
```

## Key Design Decisions

### 1. Specialists use `agent()` (ReAct with tools)
Ax's `agent()` function provides multi-turn reasoning with function calling. Each specialist gets its own `agent()` instance with only its permitted tools. The host dispatcher enforces tool permissions by filtering at dispatch time.

### 2. Router uses `ax()` (single-turn classification)
The routing classification is a single LLM call — no tools needed. `ax()` with a typed signature produces structured `RouteDecision` output. Deterministic prefix checks (`/scribe`, `/seeker`) always win.

### 3. Centralized path safety
One function — `resolveVaultPath()` — handles all vault path resolution. Rejects `..` traversal, absolute paths, and symlink escapes. Every tool delegates path validation to it. Never duplicated.

### 4. Declarative registry (YAML + Markdown)
Agent definitions live in `crew/agents/*.md` (system instructions) and `crew/registry.yaml` (metadata, triggers, tool permissions). TypeScript loader validates at startup. Easy to extend without touching runtime code.

### 5. TypeScript dispatcher enforces all policies
Agents recommend handoffs via typed `suggestedNextAgent` — TypeScript validates targets, depth, cycles, and permissions. Agents don't control routing.

### 6. Crew-level infrastructure retry (not ax's internal retry)
ax v23 has its own infrastructure retry loop (up to 3 retries with exponential
backoff for 5xx/network/timeout/stream errors). We disable that (`retry: {
maxRetries: 0 }`) and retry at the crew level instead. The crew retry loop
controls the abort signal during backoff, preventing the race condition where
`AbortSignal.timeout()` kills ax's retry mid-backoff and produces the misleading
`AxAIServiceAbortedError("infrastructure-retry-backoff")` error.

See [[incident-004-seeker-proxy-timeout]] for the full RCA.

### 7. SQLite for runtime state only

The vault is canonical. SQLite stores execution traces, runs, and tool calls. Never replaces the vault as source of truth.

## Component Map

| Component | Path | Role |
|-----------|------|------|
| CLI | `src/cli/main.ts` | Commander.js entry, 7 commands |
| Config | `src/config.ts` | Zod-validated env loading |
| Doctor | `src/cli/doctor.ts` | 8 health checks |
| Logger | `src/observability/logger.ts` | Pino structured JSON |
| Types | `src/types.ts` | Shared interfaces (AgentResult, RouteDecision, etc.) |
| Vault Path | `src/tools/vault-path.ts` | Single path-safety bottleneck |
| Vault Tools | `src/tools/vault-{read,write,append,search,list,move,frontmatter}.ts` | 8 narrow vault operations |
| Tool Registry | `src/tools/index.ts` | Tool name → approval level mapping |
| Registry | `src/registry/` | YAML loader + zod validation (Phase 3) |
| Router | `src/routing/` | Normalize + skill router + Ax classifier (Phase 5) |
| Dispatcher | `src/runtime/` | Orchestration, execution, handoffs (Phase 6) |
| AI Clients | `src/ai/` | Ax model-client factory (Phase 2) |
| Persistence | `src/persistence/` | SQLite via better-sqlite3 (Phase 7) |

## Tech Stack

- **Runtime**: Node.js v24, TypeScript 5.7 strict
- **Agent framework**: `@ax-llm/ax` v23.0.1
- **LLM proxy**: CommandCode at `http://127.0.0.1:8787/v1`
- **Database**: better-sqlite3 (synchronous, no pool needed)
- **CLI**: Commander.js + tsx
- **Validation**: Zod (config), Vitest (tests)
- **Logging**: Pino with pretty-print

## Deferred Features

| Feature | Phase | Reason |
|---------|-------|--------|
| Transcriber, Postman | 9 | Architect, Connector, Librarian, Conductor, Scout are now live in `crew/registry.yaml` |
| Skills (inbox-triage, etc.) | 8 | First skill after MVP stable |
| Custom agent creation | 9 | After Architect in registry |
| Vector search | Post-MVP | File-based search sufficient for MVP |
| Email/calendar | Post-MVP | Needs MCP connectors |
| Web UI | Post-MVP | CLI only |
| Langfuse tracing | Post-MVP | Structured logs first |
| OpenTelemetry | Post-MVP | After structured logging |
