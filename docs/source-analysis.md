# Source Analysis — My Brain Is Full Crew

> The original repository was not cloned locally. This analysis is based on the detailed build brief and inferred patterns from the source project's README and conventions.

## Source Project Summary

**My Brain Is Full Crew** (`github.com/gnekt/My-Brain-Is-Full-Crew`) is a dispatcher-led CLI application that coordinates multiple specialist coding agents to operate on an Obsidian vault. It accepts natural-language requests, routes them to the correct agent (Scribe, Seeker, Sorter, etc.), provides vault-aware tools, and records every action.

## Concept Mapping

| Source concept | Ax implementation | MVP status |
|----------------|-------------------|------------|
| Dispatcher | TypeScript host-controlled router + executor | Included |
| Specialist agents (Scribe, Seeker, Sorter) | `agent()` with agentIdentity + allowed tools (fn()) | Included |
| Agent router (classification) | `ax()` with signature → RouteDecision typed output | Included |
| Suggested next agent (handoff) | Typed `suggestedNextAgent` in AgentResult | Included |
| Skills (inbox triage, vault audit) | Explicit workflow executor with state machine | Phase 8 |
| Vault access (read, write, search, move) | `fn()` wrapped vault tools behind resolveVaultPath() | Included |
| Frontmatter operations | vaultReadFrontmatter / vaultUpdateFrontmatter (yaml parse) | Included |
| Email/calendar (Postman) | MCP or connector tools | Deferred |
| Audio transcription | External tool integration | Deferred |
| Agent definitions (YAML + Markdown) | `crew/registry.yaml` + `crew/agents/*.md` | Included |
| Run history / observability | SQLite runs/steps/tool_calls tables + Pino logging | Included |
| Approval levels (0/1/2) | toolRegistry.approvalLevel + host enforcement | Included |
| Path safety | Centralized `resolveVaultPath()` with traversal rejection | Included |
| Custom agent creation | YAML definition → validated by loader → registered | Phase 9 |

## Key Differences from Source

1. **Ax native client, not CLI agent calls** — The source project dispatched to external CLI agents (Claude Code, etc.). We use Ax's `agent()` function directly, keeping everything in-process.

2. **Typed structured output** — The source project inferred agent state from prose. We enforce typed `AgentResult` with explicit `status`, `suggestedNextAgent`, and `changedFiles`.

3. **Provider-agnostic from day one** — Connected to the CommandCode proxy, not hardcoded to Claude or OpenAI. Model tiers are configurable via env vars.

4. **New vault, not existing vault** — Creates a dedicated agent-brain-style vault rather than operating on the user's personal vault. Safer for MVP testing.

5. **Host-enforced handoff policy** — Agents recommend handoffs; TypeScript validates depth, cycles, permissions. Source project may have had looser constraints.

## Intentionally Deferred Source Features

- Email reading/sending (Postman)
- Calendar integration
- Audio transcription
- Slack/IM integration
- Vector database / semantic search
- Web dashboard UI
- Multi-user support
