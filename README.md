# Ax Brain Crew

Local-first TypeScript agent crew powered by [AxLLM](https://github.com/ax-llm/ax). Routes natural-language requests to vault-aware specialists (Scribe, Seeker, Sorter) that operate on an Obsidian vault using narrow, safe tools.

Connected to the CommandCode proxy at `127.0.0.1:8787/v1`. Provider-agnostic — swap models via env vars.

## Quick Start

```bash
cd ~/ax-brain-crew
cp .env.example .env
npm install
npm run crew -- doctor
```

All 8 checks should pass (proxy reachability requires the proxy to be running).

## Commands

```bash
# Have a conversation (remembers context, stays with the last agent)
npm run crew -- chat

# Run an OpenAI-compatible server so GUI apps (Obsidian Copilot, Open WebUI) can chat with the crew
npm run crew -- serve

# Submit a one-shot request
npm run crew -- ask "Save this idea: I want to build a visual interface..."

# Route classification only (no execution)
npm run crew -- routes "find my notes about AI agents"

# Check environment
npm run crew -- doctor

# Verify Ax + proxy connectivity
npm run crew -- smoke-test

# List registered agents
npm run crew -- agents

# List available tools
npm run crew -- tools

# Run history
npm run crew -- history
npm run crew -- show-run <run-id>

# Chat sessions (each chat = one session of many logged runs)
npm run crew -- sessions
npm run crew -- show-session <session-id>
```

## Chat

`npm run crew -- chat` opens an interactive conversation. It remembers the
transcript and stays with the last agent (sticky routing) until you switch.

```
you › save a thought: consolidate my agent infra
scribe › Saved to Inbox/consolidate-my-agent-infra.md ...
you › what folder did that go in?          # still talking to scribe, with memory
you › /seeker what do I know about agents   # switch agent with a /name prefix
you › /new                                  # start a fresh conversation
you › /exit                                 # leave (Ctrl+C also works)
```

In-chat commands: `/help`, `/agents`, `/history`, `/new` (or `/reset`),
`/exit`. Every turn is logged as a run under the session, so the whole
conversation stays inspectable with `show-session`.

## GUI clients (Obsidian Copilot, Open WebUI, …)

`npm run crew -- serve` exposes an **OpenAI-compatible** HTTP server so any
chat app that accepts a custom base URL can talk to the crew (routing, vault
tools, and all). Default port `8788` (override with `CREW_SERVE_PORT`).

- `GET  /v1/models` — lists `crew` (auto-route) plus one id per agent.
- `POST /v1/chat/completions` — standard Chat Completions (streaming + non-streaming).
  The **model id selects the agent**: `crew` lets the classifier route;
  `seeker` / `scribe` / … forces that specialist. Replies are prefixed
  `**[agent]**` so you can see who answered. Turns are logged like any run.

### Obsidian Copilot

1. Start the server: `npm run crew -- serve` (leave it running).
2. In Obsidian, install **Copilot** (Community plugins → browse → "Copilot" by
   logancyang → Install → Enable). Opening the crew vault (`./vault`) is handy so
   crew-written notes and Copilot's chat notes live together.
3. Copilot settings → **Add Model** → Custom Model:
   - Model name: `crew` (or an agent id like `seeker`)
   - Provider: **3rd party (openai format)**
   - Base URL: `http://127.0.0.1:8788/v1`
   - API key: anything (e.g. `sk-crew`) — the server ignores it
   - If Copilot reports a CORS error, enable its **CORS** toggle (streaming is
     lost in that mode; the crew replies in one shot anyway).
4. Pick the `crew` model in Copilot's chat and go. Copilot saves each chat as a
   markdown note in your vault, so old conversations are browsable/searchable.

## Explicit Routing

Prefix your request with an agent name to bypass the classifier:

```bash
npm run crew -- ask "/scribe capture this idea"
npm run crew -- ask "/seeker what do I know about databases"
npm run crew -- ask "/sorter organize my inbox"
```

## Vault Structure

The vault lives at `./vault/` and follows the agent-brain convention:

```
vault/
├── AGENTS.md          # Agent operating manual
├── Inbox/             # Uncategorized captures
├── Projects/          # Active initiatives
├── Areas/             # Ongoing responsibilities
├── Knowledge/         # Reference material
├── Daily/             # Daily notes
├── Templates/         # Note templates
└── raw/               # Immutable sources
```

## Configuration

All settings in `.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OBSIDIAN_VAULT_PATH` | `./vault` | Path to the vault |
| `PROXY_BASE_URL` | `http://127.0.0.1:8787/v1` | LLM proxy endpoint (CommandCode) |
| `PROXY_API_KEY` | `user_...` | Proxy auth token |
| `ROUTER_MODEL` | `deepseek/deepseek-v4-pro` | Model for classification |
| `FAST_MODEL` | `deepseek/deepseek-v4-pro` | Model for Scribe/Sorter |
| `SMART_MODEL` | `deepseek/deepseek-v4-pro` | Model for Seeker/synthesis |
| `DRY_RUN` | `true` | Preview changes without writing |

## Architecture

```
CLI → Router (deterministic + Ax classifier) → Dispatcher → Agent (Ax) → Vault Tools → Markdown files → SQLite log
```

Eight agents (see `crew/registry.yaml`):

- **Scribe** — captures ideas into structured notes with frontmatter
- **Seeker** — searches the vault, synthesizes answers with citations
- **Sorter** — classifies and files notes into proper folders
- **Architect** — creates project structures, MOCs, and scaffolds new vault areas
- **Connector** — discovers related notes, suggests links, identifies orphans and themes
- **Librarian** — audits vault consistency, broken links, stale structures, frontmatter
- **Conductor** — scopes ambiguous tasks and dispatches to specialists (the only agent that asks clarifying questions)
- **Scout** — explores local filesystem and GitHub to discover projects and repos

Every run is recorded in `data/crew.sqlite` with routing decisions, tool calls, and changed files.

## Testing

```bash
npm test
# or
npm run typecheck
```

## Agent Definitions

Agents are defined declaratively in `crew/registry.yaml` with instruction prompts in `crew/agents/*.md`. Add new agents by editing these files — no TypeScript changes required for basic agents.

```yaml
agents:
  my-agent:
    name: My Agent
    description: Does something useful
    instructions: crew/agents/my-agent.md
    modelTier: fast
    allowedTools:
      - vault.read
      - vault.search
    triggers:
      - do my thing
```

## Deferred

Roadmap for post-MVP phases: inbox-triage skill; custom agent creation UI; vector search; email/calendar integration; web dashboard.

## License

Private — Ben Charney
