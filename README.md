# Ax Visual Lab

**A visual workbench for building, testing, and evaluating AI agents** — powered by [AxLLM](https://ax-llm.com), the TypeScript agent framework.

Chat with agents. Trace every decision. Build typed signatures. Evaluate against datasets. Tinker in a live notebook. Everything runs locally, everything is inspectable.

<p align="center">
  <img src="docs/screenshots/01-chat-trace.png" alt="Ax Visual Lab — Chat & Trace" width="800">
</p>

---

## What It Does

### 🗣️ Chat & Trace
Talk to any agent. The **trace panel** shows every routing decision, tool call, and model invocation — nothing is a black box.

<p align="center">
  <img src="docs/screenshots/05-components.png" alt="Components — agents, tools, flows" width="800">
</p>

### 🧱 Signature Builder
Design typed AxLLM signatures visually (`query: string, tone: class → response: string`). Compiles to the Ax DSL, validated live. Save to the **bench shelf** and reuse across experiments.

<p align="center">
  <img src="docs/screenshots/02-builder.png" alt="Signature Builder" width="800">
</p>

### 📓 Live Notebook
Run JavaScript against the AxLLM runtime. `ax()`, `ai()`, and `agent()` are pre-loaded. Each cell runs through the crew backend and returns typed results — JSON, Mermaid diagrams, or HTML.

<p align="center">
  <img src="docs/screenshots/03-notebook.png" alt="Live Notebook" width="800">
</p>

### 🧪 Eval & Optimize
Run agents against curated datasets. Measure accuracy per route. Drill into failures. GEPA-optimize signatures and routers. Export experiment history.

<p align="center">
  <img src="docs/screenshots/04-eval.png" alt="Eval & Optimize" width="800">
</p>

### 📊 Dataset Builder
Curate eval datasets from real agent runs, Slack feedback, AI-generated variations, or manual authoring. One-click "accept" from the candidate tray. Coverage gaps highlighted automatically.

<p align="center">
  <img src="docs/screenshots/06-dataset-builder.png" alt="Dataset Builder" width="800">
</p>

### 🔍 Inspector
Browse all agents, tools, and flows in one panel. Jump to source code. Push agent instructions or flow definitions into the notebook.

<p align="center">
  <img src="docs/screenshots/07-inspector-agents.png" alt="Inspector — agents, tools, flows" width="800">
</p>

---

## Why AxLLM?

| Capability | What It Means |
|-----------|---------------|
| **Typed signatures** | `query: string, tone: class → response: string` — inputs and outputs are validated at runtime. No prompt injection via clever user input. |
| **Native function calling** | Tools are first-class. Agents reason about tool results and self-correct. |
| **Multi-agent routing** | A classifier agent picks the right specialist. Handoffs preserve context. |
| **Playbook learning** | Agents improve from feedback. Successful patterns are remembered, failures are avoided. |
| **TypeScript-native** | No Python, no YAML DSL, no vendor lock-in. It's just code. |

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Ax Visual Lab  (apps/lab/)                          │
│  Next.js SPA  •  5 panels  •  REST client            │
│  Zustand store  •  Monaco editor  •  Tailwind 4       │
│──────────────────────────────────────────────────────│
│                    │  HTTP (:8788)                    │
│                    ▼                                  │
│  Crew Runtime  (src/)                                │
│  Classifier → Dispatcher → Executor → Agent          │
│  SQLite persistence  •  24 tools  •  9 flows          │
│  Playbook learning  •  Langfuse tracing               │
│──────────────────────────────────────────────────────│
│                    │  forward()                       │
│                    ▼                                  │
│  AxLLM  v23                                          │
│  agent()  •  fn()  •  typed signatures                │
│──────────────────────────────────────────────────────│
│                    │                                  │
│                    ▼                                  │
│  OpenAI-compatible endpoint  (any provider)           │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/toasterman234/ax-brain-crew.git
cd ax-brain-crew
cp .env.example .env
npm install
```

### 2. Set your LLM key

Edit `.env`:

```bash
# Option A: Standard OpenAI endpoint
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.openai.com/v1

# Option B: Any OpenAI-compatible provider (Anthropic via proxy, Ollama, Together, etc.)
OPENAI_BASE_URL=https://your-proxy.example.com/v1
OPENAI_API_KEY=your-proxy-key
```

### 3. Start the backend + lab

```bash
# Terminal 1 — crew backend
npm run crew -- serve --demo

# Terminal 2 — visual lab
npm run dev --prefix apps/lab
```

Open `http://localhost:3020`.

### Or: Docker (one command)

```bash
export OPENAI_API_KEY=sk-your-key-here
docker-compose up
```

---

## Adding Your Own Agent

Agents are **YAML config + Markdown instructions**. The AxLLM runtime handles reasoning, tool calling, and structured output. You just describe what the agent is and when to use it.

### Step 1: Write the instruction prompt

Create `crew/agents/my-agent.md`:

```markdown
# Code Reviewer

## Identity
You are a thorough code reviewer. Find bugs, suggest improvements,
explain your reasoning, and show corrected code when helpful.

## Rules
- Check for security issues (injection, XSS, auth bypass)
- Check for correctness (logic errors, edge cases)
- Check for clarity (naming, structure, comments)
- Be specific — cite line numbers and suggest concrete fixes

## Output Format
Return structured output with fields: summary, issues[], suggestions[]
```

### Step 2: Register in the agent registry

Add to `crew/registry.yaml` under the `agents:` key:

```yaml
code-reviewer:
  name: Code Reviewer
  description: Reviews code for bugs, security, and clarity
  instructions: crew/agents/code-reviewer.md
  modelTier: smart
  allowedTools:
    - code.read
  triggers:
    - review this code
    - check my code
    - code review
  handoffs:
    allowedTargets: []
```

### Step 3: Restart

```bash
npm run crew -- serve --demo
```

Your agent appears in the lab's **Components** tab and in the chat model dropdown. Trigger phrases auto-route to it.

**What's happening under the hood:** The YAML config feeds into AxLLM's `agent()` function. The registry loader validates it at startup, the classifier uses trigger phrases for routing, and the executor wires up tools, playbooks, and model clients. YAML is the settings panel; Ax is the engine.

---

## Project Structure

```
ax-brain-crew/
├── apps/lab/              Visual Lab (Next.js 15 + React 19 + Zustand + Tailwind 4)
│   └── src/
│       ├── components/    16 panels (Chat, Trace, Eval, Notebook, Builder, …)
│       └── lib/           Store, bench (artifact types), demo helpers
├── src/
│   ├── agents/            Tool factory — wraps 24 tools as AxLLM fn() calls
│   ├── ai/                Model clients + capability detection
│   ├── cli/               CLI (serve, chat, doctor, smoke-test, worker)
│   ├── composition/       Orchestrator + multi-variant coordinator
│   ├── flows/             9 Ax-native flow() pipelines (triage, clean, audit, …)
│   ├── observability/     Pino logger, Langfuse tracing
│   ├── persistence/       SQLite — sessions, runs, experiments, bench
│   ├── playbooks/         Agent learning — seed, persist, edit, replay
│   ├── registry/          Agent registry — YAML loader, Zod validation
│   ├── routing/           Classifier, skill-router, policy enforcer
│   ├── runtime/           Dispatcher, executor, handoff protocol
│   └── tools/             24 tools (vault, web, memory, GitHub, code, research, …)
├── crew/
│   ├── agents/            Agent instruction prompts (Markdown)
│   ├── registry.yaml      Agent definitions (YAML)
│   └── registry.demo.yaml Demo agents for quick start
├── demo-vault/            Sample Obsidian vault (safe to modify)
├── tests/                 Vitest — 30+ test files
├── docs/                  Architecture docs + screenshots
├── docker-compose.yml     One-command Docker setup
├── Dockerfile.backend     Crew runtime container
└── Dockerfile.lab         Visual Lab container
```

---

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Custom endpoint |
| `ROUTER_MODEL` | `gpt-4.1-mini` | Model for request classification |
| `FAST_MODEL` | `gpt-4.1-mini` | Model for fast-tier agents |
| `SMART_MODEL` | `gpt-4.1` | Model for smart-tier agents |
| `OBSIDIAN_VAULT_PATH` | (empty) | Path to a real Obsidian vault (enables vault tools) |
| `CREW_DEMO_MODE` | `false` | Skip personal integrations |
| `CREW_SERVE_PORT` | `8788` | Backend port |
| `DATABASE_PATH` | `./data/crew.sqlite` | SQLite path |
| `LOG_LEVEL` | `info` | Pino log level |

---

## License

MIT
