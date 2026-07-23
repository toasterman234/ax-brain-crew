# Ax Visual Lab

A visual interface for building, testing, and evaluating [AxLLM](https://ax-llm.com) agents. Part of the [Ax Brain Crew](../README.md) monorepo.

## Features

- **Chat & Trace** — talk to agents, see routing decisions and tool calls in real time
- **Builder** — create typed signatures (`input -> output`) with a visual editor
- **Notebook** — run JavaScript with AxLLM pre-loaded (`ax()`, `ai()`, `agent()`)
- **Eval & Optimize** — run agents against datasets, measure accuracy, GEPA-optimize
- **Components** — browse agents, tools, flows; save signatures to the bench shelf
- **Dataset Builder** — curate eval datasets from runs, variations, and manual cases
- **Session Browser** — browse and replay past conversations
- **Runs History** — inspect every dispatch with full trace

## Architecture

The lab is a Next.js 15 SPA (React 19, Zustand, Tailwind 4) that connects to the crew backend on port 8788. All data flows through REST API calls — the lab has no direct database access, no LLM client, and no secrets.

```
Lab (:3020)  ──fetch──►  Crew Backend (:8788)  ──forward()──►  AxLLM  ──►  LLM endpoint
```

## Running

The lab is an app inside the ax-brain-crew monorepo. From the repo root:

```bash
npm install
npm run crew -- serve --demo    # start backend (terminal 1)
npm run dev --prefix apps/lab   # start lab (terminal 2)
```

Open `http://localhost:3020`.

By default the lab connects to `http://127.0.0.1:8788`. To use a different backend, change `backendUrl` in `apps/lab/src/lib/store.ts` or set the `NEXT_PUBLIC_BACKEND_URL` env var.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router, Turbopack) |
| UI | React 19, Zustand 5, Tailwind CSS 4 |
| Panels | react-resizable-panels |
| Code editor | @monaco-editor/react |
| Chat UI | @assistant-ui/react |
| AI runtime | AxLLM v23 |

## File Structure

```
apps/lab/
├── src/
│   ├── app/              Next.js app (layout, page)
│   ├── components/       16 panels (ChatPanel, EvalPanel, etc.)
│   ├── lib/
│   │   ├── store.ts      Zustand state (messages, trace, bench, sessions)
│   │   ├── bench.ts      Artifact types + compiler
│   │   └── demo.ts       Demo mode helpers
│   └── types/            Shared TypeScript types
├── next.config.ts
├── package.json
└── tsconfig.json
```

## Development

```bash
cd apps/lab
npm run dev       # Start dev server on :3020
npm run build     # Production build
npm run lint      # Type check
```

## Related

- [Ax Brain Crew](../README.md) — the agent runtime this lab connects to
- [Adding Your Own Agent](../demo-vault/Adding-Your-Own-Agent.md) — YAML + Markdown guide
- [Architecture Overview](../docs/architecture.md) — how the crew assembles
