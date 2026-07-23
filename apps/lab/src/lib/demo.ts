import type { ToolCallEvent } from "./store";

// Demo data for when no backend is connected
export const DEMO_MESSAGES = [
  {
    role: "user" as const,
    content: "find my notes about AI agents",
    timestamp: Date.now() - 120_000,
  },
  {
    role: "agent" as const,
    content:
      "Found 3 notes about AI agents in your vault:\n\n1. **Knowledge/ai-agents.md** — Overview of agent architectures\n2. **Projects/agent-infra.md** — Your current agent infrastructure\n3. **Daily/2026-07-20.md** — Today's notes on multi-agent patterns\n\nAll three reference your ax-brain-crew setup and the move away from RLM-based agents.",
    timestamp: Date.now() - 115_000,
  },
];

export const DEMO_TRACE: ToolCallEvent[] = [
  {
    id: "tc-1",
    name: "classify",
    args: { query: "find my notes about AI agents" },
    result: { agent: "seeker", mechanism: "keyword", confidence: 0.95 },
    source: {
      file: "src/router/classify.ts",
      line: 42,
      function: "classifyRequest",
      tuningTips: [
        "Keyword matching is case-sensitive. Add normalize for better recall.",
        "Confidence threshold is 0.7. Lower to 0.5 for broader routing.",
      ],
    },
    durationMs: 120,
    timestamp: Date.now() - 114_000,
  },
  {
    id: "tc-2",
    name: "vault.searchVaultFiles",
    args: { query: "AI agents", limit: 20 },
    result: { count: 12, files: ["Knowledge/ai-agents.md", "Projects/agent-infra.md", "Daily/2026-07-20.md"] },
    source: {
      file: "src/tools/vault-search.ts",
      line: 42,
      function: "searchVaultFiles",
      tuningTips: [
        "Uses substring matching. Switch to FTS5 for relevance ranking.",
        "Limit default is 20. Increase for broader searches.",
      ],
    },
    durationMs: 340,
    timestamp: Date.now() - 113_500,
  },
  {
    id: "tc-3",
    name: "vault.readVaultFile",
    args: { path: "Knowledge/ai-agents.md" },
    result: { size: 2400, preview: "# AI Agents\n\n## Architectures\n..." },
    source: {
      file: "src/tools/vault-read.ts",
      line: 28,
      function: "readVaultFile",
      tuningTips: [
        "Returns full file content. Add maxChars param for large files.",
      ],
    },
    durationMs: 180,
    timestamp: Date.now() - 113_000,
  },
  {
    id: "tc-4",
    name: "vault.readVaultFile",
    args: { path: "Projects/agent-infra.md" },
    result: { size: 3100, preview: "# Agent Infrastructure\n\n## Current Setup..." },
    source: {
      file: "src/tools/vault-read.ts",
      line: 28,
      function: "readVaultFile",
      tuningTips: [],
    },
    durationMs: 160,
    timestamp: Date.now() - 112_500,
  },
];

export const DEMO_MERMAID = `sequenceDiagram
    participant U as You
    participant R as Router
    participant S as Seeker
    participant V as Vault Tools

    U->>R: "find my notes about AI agents"
    R->>R: classify → seeker (keyword match)
    R->>S: route to Seeker
    S->>V: vault.searchVaultFiles("AI agents")
    V-->>S: 12 results (3 relevant)
    S->>V: vault.readVaultFile ×3
    V-->>S: file contents
    S-->>U: synthesized answer with 3 citations

    Note over S: Used deepseek-v4-pro<br/>3 tool calls, 1.2s total`;
