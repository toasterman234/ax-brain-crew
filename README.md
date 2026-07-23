# Ax Brain Crew + Visual Lab

An [AxLLM](https://ax-llm.com) agent runtime with a visual interface for building, testing, and evaluating AI agents.

**Chat** with agents. **Trace** their decisions. **Build** typed signatures. **Evaluate** against datasets. **Tinker** in a live notebook. All local, all yours.

![Architecture](docs/architecture.md)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Ax Visual Lab  (apps/lab/)                  │
│  Next.js SPA • Chat • Trace • Eval • Builder │
│  ────────────────────────────────────────────│
│                    │  REST API               │
│                    ▼                         │
│  Crew Runtime  (src/)                        │
│  Agent routing • Tool factory • 9 flows     │
│  24 tools • SQLite persistence • Playbooks   │
│  ────────────────────────────────────────────│
│                    │                         │
│                    ▼                         │
│  AxLLM  (agent / function calling / types)   │
│  ────────────────────────────────────────────│
│                    │                         │
│                    ▼                         │
│  OpenAI-compatible endpoint  (your key)      │
└──────────────────────────────────────────────┘
```

**Agents** are defined in YAML (metadata + trigger phrases + tool permissions) with Markdown instruction prompts. The runtime engine is AxLLM's `agent()` function — YAML is the settings panel, Ax is the engine. [Add your own agent in 5 minutes →](demo-vault/Adding-Your-Own-Agent.md)

---

## Quick Start

### Option A: Local (recommended for development)

```bash
git clone https://github.com/toasterman234/ax-brain-crew.git
cd ax-brain-crew
cp .env.example .env
# Set your LLM endpoint (pick one):
#   Path A:   OPENAI_API_KEY=sk-...  OPENAI_BASE_URL=https://api.openai.com/v1
#   Path B:   PROXY_BASE_URL=...     PROXY_API_KEY=...
npm install
npm run crew -- serve --demo    # backend on :8788
npm run dev --prefix apps/lab   # lab on :3020  (in a second terminal)
```

Open `http://localhost:3020` — you're in the Visual Lab.

### Option B: Docker

```bash
git clone https://github.com/toasterman234/ax-brain-crew.git
cd ax-brain-crew
export OPENAI_API_KEY=sk-your-key-here
docker-compose up
```

Open `http://localhost:3020`.

---

## What You Can Do

| Tab | What It Does |
|-----|-------------|
| **Chat & Trace** | Talk to agents, see routing decisions, inspect tool calls |
| **Builder** | Create typed AxLLM signatures (`input -> output`) with a visual editor |
| **Notebook** | Run JavaScript against the AxLLM runtime — `ax()`, `ai()`, `agent()` pre-loaded |
| **Eval & Optimize** | Run agents against datasets, measure accuracy, GEPA-optimize signatures |
| **Components** | Browse agents, tools, flows — shelf for saving artifacts |

---

## Adding Your Own Agent

1. Create `crew/agents/my-agent.md` — the instruction prompt
2. Add to `crew/registry.yaml` — metadata, tools, trigger phrases
3. Restart `crew serve`

Full guide: [`demo-vault/Adding-Your-Own-Agent.md`](demo-vault/Adding-Your-Own-Agent.md)

### Example: a code-review agent

**`crew/agents/code-reviewer.md`:**
```markdown
# Code Reviewer
You are a thorough code reviewer. Find bugs, suggest improvements, and
explain your reasoning.
```

**`crew/registry.yaml` entry:**
```yaml
code-reviewer:
  name: Code Reviewer
  description: Reviews code for bugs and improvements
  instructions: crew/agents/code-reviewer.md
  modelTier: smart
  allowedTools: []
  triggers:
    - review this code
    - check my code
  handoffs:
    allowedTargets: []
```

That's it. Restart and it appears in the lab. The YAML tells AxLLM "when the user says 'review this code', route to this agent with these instructions." Ax handles the reasoning, structured output, and tool calling.

---

## Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your API key |
| `OPENAI_BASE_URL` | No | Custom endpoint (default: `https://api.openai.com/v1`) |
| `ROUTER_MODEL` | No | Model for request classification (default: `gpt-4.1-mini`) |
| `FAST_MODEL` | No | Model for simple agents (default: `gpt-4.1-mini`) |
| `SMART_MODEL` | No | Model for complex agents (default: `gpt-4.1`) |
| `OBSIDIAN_VAULT_PATH` | No | Path to an Obsidian vault (enables vault tools) |
| `CREW_DEMO_MODE` | No | Set to `true` for clean demo experience |

---

## Project Structure

```
ax-brain-crew/
├── apps/lab/            Visual Lab (Next.js SPA)
├── src/
│   ├── agents/          Tool factory (AxLLM fn() wrappers)
│   ├── ai/              Model client + capability detection
│   ├── cli/             CLI entry points (serve, chat, doctor)
│   ├── composition/     Orchestrator + coordinator
│   ├── flows/           9 Ax-native flow() pipelines
│   ├── observability/   Logger, Langfuse tracing
│   ├── persistence/     SQLite (sessions, runs, experiments)
│   ├── playbooks/       Agent learning (persist, seed, edit)
│   ├── registry/        Agent registry loader (YAML → validated agents)
│   ├── routing/         Classifier, router, policy enforcer
│   ├── runtime/         Dispatcher, executor, handoff protocol
│   ├── tools/           24 tools (vault, web, memory, GitHub, code)
│   └── config.ts        Configuration from env vars
├── crew/
│   ├── agents/          Agent instruction prompts (Markdown)
│   ├── registry.yaml    Agent definitions (YAML)
│   └── registry.demo.yaml  Demo agent definitions
├── demo-vault/          Sample vault for quick start
├── docs/                Architecture + design docs
├── tests/               Vitest test suite
└── docker-compose.yml   One-command Docker setup
```

---

## License

MIT
