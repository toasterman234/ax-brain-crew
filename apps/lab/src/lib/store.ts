// Core state for the visual lab
import { create } from "zustand";
import type { BenchArtifact } from "./bench";
import { scaffoldNotebookCell } from "./bench";

export type PanelId = "chat-trace" | "notebook" | "eval" | "components" | "builder";

export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  source?: {
    file: string;
    line: number;
    function: string;
    tuningTips?: string[];
  };
  durationMs: number;
  timestamp: number;
}

export interface TraceState {
  mermaidDiagram: string | null;
  toolCalls: ToolCallEvent[];
  routeDecision: {
    agent: string;
    model: string;
    mechanism: string;
  } | null;
  isStreaming: boolean;
  langfuseUrl: string | null;
}

export interface NotebookCell {
  id: string;
  code: string;
  output: unknown;
  outputType: "json" | "mermaid" | "html" | "text" | "error" | null;
  isRunning: boolean;
  timestamp: number;
}

export type EvalMode = "router" | "flow" | "signature" | "custom" | "agent";

interface LabState {
  // Panel visibility
  activePanel: "chat-trace" | "notebook" | "eval" | "components" | "builder";
  evalMode: EvalMode;
  inspectorOpen: boolean;
  inspectorTab: "agents" | "tools" | "flows" | "playbooks";

  // Bench (shared shelf)
  bench: BenchArtifact[];
  benchLoaded: boolean;
  loadBench: () => Promise<void>;
  saveArtifact: (artifact: BenchArtifact) => Promise<BenchArtifact | null>;
  removeArtifact: (id: string) => Promise<boolean>;
  getArtifact: (id: string) => BenchArtifact | undefined;
  builderArtifactId: string | null;
  setBuilderArtifactId: (id: string | null) => void;
  editSignatureInBuilder: (id: string) => void;

  // Agent selector
  availableModels: string[];
  selectedModel: string;
  isAgentForced: boolean;
  setSelectedModel: (model: string) => void;
  fetchModels: () => Promise<void>;

  // Chat
  messages: Array<{
    role: "user" | "agent";
    content: string;
    trace?: TraceState;
    timestamp: number;
  }>;
  isChatStreaming: boolean;
  streamingStatus: string | null;
  streamingAnswer: string | null;

  // Trace (current turn)
  currentTrace: TraceState;

  // Notebook
  cells: NotebookCell[];

  // Connection
  backendUrl: string;
  isConnected: boolean;

  // Source navigation (7C)
  navigateToSource: (file: string, line: number) => Promise<void>;

  // Cross-tab actions — push data from any tab into the notebook
  pushToNotebook: (code: string) => void;
  sendSignatureToNotebook: (id: string) => void;
  sendSignatureToEval: (id: string) => void;

  // Actions
  setActivePanel: (panel: "chat-trace" | "notebook" | "eval" | "components" | "builder") => void;
  setEvalMode: (mode: "router" | "flow" | "signature" | "custom") => void;
  toggleInspector: () => void;
  setInspectorTab: (tab: "agents" | "tools" | "flows" | "playbooks") => void;
  addMessage: (msg: {
    role: "user" | "agent";
    content: string;
    trace?: TraceState;
  }) => void;
  setIsChatStreaming: (v: boolean) => void;
  setStreamingStatus: (s: string | null) => void;
  appendStreamingAnswer: (chunk: string) => void;
  updateCurrentTrace: (patch: Partial<TraceState>) => void;
  resetCurrentTrace: () => void;
  addToolCall: (tc: ToolCallEvent) => void;
  updateToolCall: (id: string, patch: Partial<ToolCallEvent>) => void;
  addCell: (code?: string) => void;
  updateCell: (id: string, patch: Partial<NotebookCell>) => void;
  removeCell: (id: string) => void;
  runCell: (id: string) => Promise<void>;
  setBackendUrl: (url: string) => void;
  setConnected: (v: boolean) => void;

  // Eval cross-tab target (Phase 3)
  evalTarget: { kind: "signature"; artifactId: string } | null;
  setEvalTarget: (t: { kind: "signature"; artifactId: string } | null) => void;

  // Sessions (Phase 2)
  sessions: SessionSummary[];
  activeSessionId: string | null;
  fetchSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  clearSession: () => void;

  // Runs history (Phase 3)
  runs: RunSummary[];
  selectedRunTrace: TraceState | null;
  showRunHistory: boolean;
  fetchRuns: (sessionId?: string) => Promise<void>;
  loadRunTrace: (runId: string) => Promise<void>;
  setShowRunHistory: (v: boolean) => void;

  // Phase 4: Push an eval result trace to the TracePanel
  pushEvalTrace: (params: { label: string; routeAgent: string; mechanism: string; toolCalls?: ToolCallEvent[] }) => void;

  // Phase 5: Save eval result to bench shelf
  saveEvalToShelf: (params: { name: string; axString: string; metric: string; accuracy: number; hits: number; total: number }) => void;

  // Dataset Builder
  showDatasetBuilder: boolean;
  setShowDatasetBuilder: (v: boolean) => void;
  candidates: Candidate[];
  builderDatasetId: string | null;
  builderDatasetType: 'router' | 'flow';
  setBuilderDatasetId: (id: string | null) => void;
  setBuilderDatasetType: (t: 'router' | 'flow') => void;
  addCandidates: (cands: Candidate[]) => void;
  updateCandidate: (candidateId: string, patch: Partial<Candidate>) => void;
  acceptCandidate: (candidateId: string) => Promise<void>;
  rejectCandidate: (candidateId: string) => void;
  acceptAllPending: () => Promise<{ saved: number; errors: string[] }>;
  addManualCandidate: (partial: { caseFields: Record<string, unknown>; datasetId: string; datasetType: 'router' | 'flow' }) => void;
  clearCandidates: () => void;

  // Phase 2: source actions
  loadSlackCandidates: () => Promise<Candidate[] | undefined>;
  loadProposedCandidates: (opts?: { target?: string; lookback?: number }) => Promise<Candidate[] | undefined>;
  generateVariations: (seedCaseId: string, n: number) => Promise<void>;
  sendRunsToTray: (runIds: string[]) => void;

  // Phase 3: dataset management
  datasetList: DatasetSummary[];
  selectedDatasetId: string | null;
  datasetCases: Record<string, unknown>[];
  datasetCoverage: DatasetCoverage | null;
  fetchDatasets: () => Promise<void>;
  setSelectedDatasetId: (id: string | null) => void;
  fetchDatasetCases: (datasetId: string) => Promise<void>;
  fetchDatasetCoverage: (datasetId: string) => Promise<void>;
  deleteDatasetCase: (datasetId: string, caseId: string) => Promise<void>;
  fillGap: (datasetId: string, agent: string) => void;
}

export interface Candidate {
  candidateId: string;
  datasetId: string;
  datasetType: 'router' | 'flow';
  source: 'run' | 'slack' | 'variation' | 'gap' | 'manual' | 'proposed';
  sourceRef: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  case: Record<string, unknown>;
}

export interface DatasetSummary {
  id: string;
  type: 'router' | 'flow';
  file: string;
  caseCount: number;
  regressionCount: number;
}

export interface DatasetCoverage {
  total: number;
  regressionCount: number;
  byRoute: Record<string, number>;
  thin: string[];
}

export interface RunSummary {
  id: string;
  session_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  original_request: string;
  selected_route_id: string | null;
  route_confidence: number | null;
  route_reason: string | null;
  request_preview: string;
  response_preview: string | null;
  durationMs: number | null;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  turn_count: number;
  started_at: string;
  ended_at: string | null;
}

let cellCounter = 0;
const nextCellId = () => `cell-${++cellCounter}`;

export const useLabStore = create<LabState>()((set, get) => ({
  activePanel: "chat-trace",
  inspectorOpen: false,
  inspectorTab: "agents",
  evalMode: "router" as EvalMode,
  messages: [],
  isChatStreaming: false,
  streamingStatus: null,
  streamingAnswer: null,
  currentTrace: {
    mermaidDiagram: null,
    toolCalls: [],
    routeDecision: null,
    isStreaming: false,
    langfuseUrl: null,
  },
  cells: [
    {
      id: nextCellId(),
      code: '// ax, ai, agent, llm are pre-loaded and ready\n// ax(signature).forward(llm, input) → structured output\n\nconst r = await ax("query -> short_answer")\n  .forward(llm, { query: "What is 2+2?" });\nr',
      output: null,
      outputType: null,
      isRunning: false,
      timestamp: Date.now(),
    },
  ],
  backendUrl: "http://127.0.0.1:8788",
  isConnected: false,

  // Agent selector
  availableModels: [],
  selectedModel: "crew",
  isAgentForced: false,

  setSelectedModel: (model) => {
    set({ selectedModel: model, isAgentForced: model !== "crew" });
  },

  fetchModels: async () => {
    const { backendUrl, setSelectedModel } = get();
    try {
      const res = await fetch(`${backendUrl}/v1/models`);
      if (!res.ok) return;
      const data = await res.json();
      const models: string[] = (data as { data?: Array<{ id: string }> }).data?.map((m) => m.id) ?? [];
      if (models.length > 0) {
        set({ availableModels: models });
        // Keep current selection if it's still valid
        const current = get().selectedModel;
        if (!models.includes(current)) {
          setSelectedModel("crew");
        }
      }
    } catch {
      // Non-critical — models dropdown just won't populate
    }
  },

  // Bench
  bench: [],
  benchLoaded: false,
  builderArtifactId: null,

  // Eval target

  setBuilderArtifactId: (id) => set({ builderArtifactId: id }),
  evalTarget: null,

  setActivePanel: (panel) => set({ activePanel: panel }),
  setEvalMode: (mode: EvalMode) => set({ evalMode: mode as EvalMode }),
  toggleInspector: () =>
    set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, { ...msg, timestamp: Date.now() }] })),
  setIsChatStreaming: (v) => set({ isChatStreaming: v }),
  setStreamingStatus: (s) => set({ streamingStatus: s }),
  appendStreamingAnswer: (chunk) =>
    set((s) => ({
      streamingAnswer: (s.streamingAnswer ?? "") + chunk,
    })),
  updateCurrentTrace: (patch) =>
    set((s) => ({
      currentTrace: { ...s.currentTrace, ...patch },
    })),
  resetCurrentTrace: () =>
    set({
      currentTrace: {
        mermaidDiagram: null,
        toolCalls: [],
        routeDecision: null,
        isStreaming: false,
        langfuseUrl: null,
      },
    }),
  addToolCall: (tc) =>
    set((s) => ({
      currentTrace: {
        ...s.currentTrace,
        toolCalls: [...s.currentTrace.toolCalls, tc],
      },
    })),
  updateToolCall: (id, patch) =>
    set((s) => ({
      currentTrace: {
        ...s.currentTrace,
        toolCalls: s.currentTrace.toolCalls.map((tc) =>
          tc.id === id ? { ...tc, ...patch } : tc
        ),
      },
    })),
  addCell: (code) =>
    set((s) => ({
      cells: [
        ...s.cells,
        {
          id: nextCellId(),
          code: code ?? "// Write code here",
          output: null,
          outputType: null,
          isRunning: false,
          timestamp: Date.now(),
        },
      ],
    })),
  updateCell: (id, patch) =>
    set((s) => ({
      cells: s.cells.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  removeCell: (id) =>
    set((s) => ({ cells: s.cells.filter((c) => c.id !== id) })),
  runCell: async (id: string) => {
    const cell = get().cells.find((c) => c.id === id);
    if (!cell || cell.isRunning) return;

    set((s) => ({
      cells: s.cells.map((c) =>
        c.id === id ? { ...c, isRunning: true } : c
      ),
    }));

    // Reset the current trace for this cell execution
    get().resetCurrentTrace();
    get().updateCurrentTrace({
      isStreaming: true,
      routeDecision: { agent: 'notebook', model: '', mechanism: 'cell execution' },
    });

    // Add a tool_call event for the cell execution itself
    get().addToolCall({
      id: `nb-${id}`,
      name: 'notebook.eval',
      args: { code: cell.code.slice(0, 100) + (cell.code.length > 100 ? '...' : '') },
      durationMs: 0,
      timestamp: Date.now(),
    });

    try {
      const res = await fetch(`${get().backendUrl}/api/notebook/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: cell.code }),
      });
      const data = await res.json();

      // If the result looks like an ax call (has thought/answer fields),
      // emit additional trace events
      if (data.result && typeof data.result === 'object' && !data.error) {
        const r = data.result as Record<string, unknown>;
        const hasAxShape = r.thought || r.short_answer || r.answer;
        if (hasAxShape) {
          const keys = Object.keys(r).filter(k => k !== 'thought');
          get().addToolCall({
            id: `ax-${id}`,
            name: 'ax.forward',
            args: { outputs: keys.join(', ') },
            result: JSON.stringify(r).slice(0, 200),
            durationMs: 0,
            timestamp: Date.now(),
          });
        }
      }

      set((s) => ({
        cells: s.cells.map((c) =>
          c.id === id
            ? {
                ...c,
                output: data.result ?? data.error,
                outputType: data.error
                  ? "error"
                  : data.richOutput?.mermaid
                    ? "mermaid"
                    : data.richOutput?.html
                      ? "html"
                      : "json",
                isRunning: false,
                timestamp: Date.now(),
              }
            : c
        ),
      }));

      get().updateCurrentTrace({ isStreaming: false });
    } catch (e) {
      set((s) => ({
        cells: s.cells.map((c) =>
          c.id === id
            ? {
                ...c,
                output: String(e),
                outputType: "error",
                isRunning: false,
                timestamp: Date.now(),
              }
            : c
        ),
      }));
      get().updateCurrentTrace({ isStreaming: false });
    }
  },
  setBackendUrl: (url) => set({ backendUrl: url }),
  setConnected: (v) => set({ isConnected: v }),

  // 7C: Navigate to source file — fetches content and opens it in a notebook cell
  navigateToSource: async (file: string, line: number) => {
    const { backendUrl, addCell, setActivePanel } = get();
    setActivePanel("notebook");

    try {
      const res = await fetch(`${backendUrl}/api/files?path=${encodeURIComponent(file)}`);
      const data = await res.json();
      if (data.content) {
        const headerComment = `// 📄 ${file}:${line}`;
        addCell(`${headerComment}\n${data.content}`);
      } else {
        addCell(`// 📄 ${file}:${line}\n// (could not load file: ${data.error || 'unknown'})`);
      }
    } catch {
      addCell(`// 📄 ${file}:${line}\n// (could not reach backend)`);
    }
  },

  // Cross-tab: push code/text from any tab directly into a notebook cell
  pushToNotebook: (code: string) => {
    const { addCell, setActivePanel } = get();
    setActivePanel("notebook");
    addCell(code);
  },

  // Cross-tab: scaffold a signature from the shelf into a notebook cell
  sendSignatureToNotebook: (id: string) => {
    const artifact = get().bench.find((a) => a.id === id);
    if (!artifact || artifact.kind !== "signature") return;
    const code = scaffoldNotebookCell(artifact);
    get().pushToNotebook(code);
  },

  sendSignatureToEval: (id: string) => {
    const artifact = get().bench.find((a) => a.id === id);
    if (!artifact || artifact.kind !== "signature") return;
    set({
      evalTarget: { kind: "signature", artifactId: id },
      evalMode: "signature" as EvalMode,
      activePanel: "eval",
    });
  },

  editSignatureInBuilder: (id: string) => {
    const artifact = get().bench.find((a) => a.id === id);
    if (!artifact || artifact.kind !== "signature") return;
    set({
      builderArtifactId: id,
      activePanel: "builder",
    });
  },

  // Bench actions
  loadBench: async () => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/bench`);
      if (!res.ok) return;
      const data = (await res.json()) as { artifacts: BenchArtifact[] };
      set({ bench: data.artifacts ?? [], benchLoaded: true });
    } catch {
      // Backend unavailable — bench stays empty.
    }
  },

  saveArtifact: async (artifact: BenchArtifact) => {
    const { backendUrl, bench } = get();
    // Optimistic update
    const existing = bench.findIndex((a) => a.id === artifact.id);
    const next = existing >= 0
      ? bench.map((a) => (a.id === artifact.id ? artifact : a))
      : [...bench, artifact];
    set({ bench: next });

    try {
      const res = await fetch(`${backendUrl}/api/bench/${artifact.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(artifact),
      });
      if (!res.ok) throw new Error(`PUT returned ${res.status}`);
      const saved = (await res.json()) as BenchArtifact;
      // Re-sync from server
      set((s) => ({
        bench: s.bench.some((a) => a.id === saved.id)
          ? s.bench.map((a) => (a.id === saved.id ? saved : a))
          : [...s.bench, saved],
      }));
      return saved;
    } catch {
      // Rollback on failure
      set({ bench });
      return null;
    }
  },

  removeArtifact: async (id: string) => {
    const { backendUrl, bench } = get();
    const prev = bench;
    set({ bench: bench.filter((a) => a.id !== id) });

    try {
      const res = await fetch(`${backendUrl}/api/bench/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`DELETE returned ${res.status}`);
      return true;
    } catch {
      set({ bench: prev });
      return false;
    }
  },

  getArtifact: (id: string) => {
    return get().bench.find((a) => a.id === id);
  },

  setEvalTarget: (t) => set({ evalTarget: t }),

  // Sessions
  sessions: [],
  activeSessionId: null,

  fetchSessions: async () => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/sessions`);
      if (!res.ok) return;
      const data = await res.json();
      set({ sessions: (data as { sessions: SessionSummary[] }).sessions ?? [] });
    } catch {
      // Non-critical
    }
  },

  loadSession: async (sessionId: string) => {
    const { backendUrl, clearSession } = get();
    try {
      const res = await fetch(`${backendUrl}/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const session = data.session as { id: string; title: string | null };
      const runs = data.runs as Array<{
        original_request: string;
        final_response: string | null;
        selected_route_id: string | null;
        route_reason: string | null;
        error: string | null;
      }>;

      // Reconstruct messages from runs (user → agent pairs)
      const messages: Array<{
        role: "user" | "agent";
        content: string;
        trace?: TraceState;
        timestamp: number;
      }> = [];

      for (const run of runs) {
        messages.push({
          role: "user",
          content: run.original_request,
          timestamp: Date.now(),
        });
        if (run.final_response) {
          const trace: TraceState = {
            mermaidDiagram: null,
            toolCalls: [],
            routeDecision: run.selected_route_id
              ? {
                  agent: run.selected_route_id,
                  model: "",
                  mechanism: run.route_reason ?? "loaded from history",
                }
              : null,
            isStreaming: false,
            langfuseUrl: null,
          };
          messages.push({
            role: "agent",
            content: run.final_response,
            trace,
            timestamp: Date.now(),
          });
        } else if (run.error) {
          messages.push({
            role: "agent",
            content: `⚠️ Error: ${run.error}`,
            timestamp: Date.now(),
          });
        }
      }

      set({
        messages,
        activeSessionId: sessionId,
        currentTrace: {
          mermaidDiagram: null,
          toolCalls: [],
          routeDecision: null,
          isStreaming: false,
          langfuseUrl: null,
        },
      });
    } catch {
      // Session load failed
    }
  },

  clearSession: () => {
    set({
      messages: [],
      activeSessionId: null,
      currentTrace: {
        mermaidDiagram: null,
        toolCalls: [],
        routeDecision: null,
        isStreaming: false,
        langfuseUrl: null,
      },
    });
  },

  // Runs history
  runs: [],
  selectedRunTrace: null,
  showRunHistory: false,

  // Dataset Builder
  showDatasetBuilder: false,
  setShowDatasetBuilder: (v) => set({ showDatasetBuilder: v }),
  candidates: [],
  builderDatasetId: null,
  builderDatasetType: 'router',
  setBuilderDatasetId: (id) => set({ builderDatasetId: id }),
  setBuilderDatasetType: (t) => set({ builderDatasetType: t }),

  addCandidates: (cands) => {
    set((s) => {
      const existingIds = new Set(s.candidates.map((c) => c.case.id as string));
      const deduped = cands.filter((c) => !existingIds.has(c.case.id as string));
      if (deduped.length === 0) return {};
      return { candidates: [...s.candidates, ...deduped] };
    });
  },

  updateCandidate: (candidateId, patch) => {
    set((s) => ({
      candidates: s.candidates.map((c) =>
        c.candidateId === candidateId ? { ...c, ...patch } : c
      ),
    }));
  },

  acceptCandidate: async (candidateId) => {
    const state = get();
    const cand = state.candidates.find((c) => c.candidateId === candidateId);
    if (!cand) return;
    try {
      const res = await fetch(`${state.backendUrl}/api/datasets/${cand.datasetId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: [cand.case] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      get().updateCandidate(candidateId, { status: 'accepted' });
    } catch (err) {
      console.error('acceptCandidate failed:', err);
    }
  },

  rejectCandidate: (candidateId) => {
    get().updateCandidate(candidateId, { status: 'rejected' });
  },

  acceptAllPending: async () => {
    const state = get();
    const pending = state.candidates.filter((c) => c.status === 'pending');
    if (pending.length === 0) return { saved: 0, errors: [] };

    // Group by datasetId
    const groups = new Map<string, { datasetType: 'router' | 'flow'; cases: Record<string, unknown>[] }>();
    for (const cand of pending) {
      const g = groups.get(cand.datasetId);
      if (g) {
        g.cases.push(cand.case);
      } else {
        groups.set(cand.datasetId, { datasetType: cand.datasetType, cases: [cand.case] });
      }
    }

    let saved = 0;
    const errors: string[] = [];
    for (const [datasetId, group] of groups) {
      try {
        const res = await fetch(`${state.backendUrl}/api/datasets/${datasetId}/cases/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cases: group.cases }),
        });
        if (!res.ok) {
          errors.push(`${datasetId}: HTTP ${res.status}`);
          continue;
        }
        const data = await res.json() as { caseCount?: number };
        saved += data.caseCount ?? group.cases.length;
        // Mark all in this group as accepted
        const acceptedIds = new Set(group.cases.map((c) => c.id as string));
        set((s) => ({
          candidates: s.candidates.map((c) =>
            acceptedIds.has(c.case.id as string)
              ? { ...c, status: 'accepted' as const }
              : c
          ),
        }));
      } catch (err) {
        errors.push(`${datasetId}: ${String(err)}`);
      }
    }
    return { saved, errors };
  },

  addManualCandidate: (partial) => {
    const candidateId = `cand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cand: Candidate = {
      candidateId,
      datasetId: partial.datasetId,
      datasetType: partial.datasetType,
      source: 'manual',
      sourceRef: null,
      status: 'pending',
      case: partial.caseFields,
    };
    get().addCandidates([cand]);
  },

  clearCandidates: () => set({ candidates: [] }),

  // Phase 2: source actions — feed the candidate tray
  loadSlackCandidates: async () => {
    const { backendUrl, addCandidates } = get();
    try {
      const res = await fetch(`${backendUrl}/api/eval-pairs?reviewed=0&limit=100`);
      if (!res.ok) return;
      const data = await res.json() as { pairs: Array<{ id: string; kind: string; input: string; output: string | null; signal: string; route_agent: string | null }> };
      const cands: Candidate[] = (data.pairs ?? []).map((p) => {
        const isRouter = p.kind === 'routing-override';
        const datasetId = isRouter ? 'routing-cases' : (p.route_agent ? `${p.route_agent}-cases` : 'custom-cases');
        const datasetType: 'router' | 'flow' = isRouter ? 'router' : 'flow';
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const caseFields: Record<string, unknown> = isRouter
          ? { id: `slack-routing-${stamp}-${p.id.slice(0, 8)}`, request: p.input, expectedAgent: p.signal, regression: false, sourceSlackPairId: p.id }
          : { id: `slack-flow-${stamp}-${p.id.slice(0, 8)}`, input: p.input, expected: { corrected: p.signal, originalOutput: p.output }, regression: true, sourceSlackPairId: p.id };
        return { candidateId: `cand-slack-${p.id}`, datasetId, datasetType, source: 'slack' as const, sourceRef: p.id, status: 'pending' as const, case: caseFields };
      });
      addCandidates(cands);
      return cands;
    } catch (err) {
      console.error('loadSlackCandidates failed:', err);
      return [];
    }
  },

  loadProposedCandidates: async (opts) => {
    const { backendUrl, addCandidates, builderDatasetId, builderDatasetType,
      resetCurrentTrace, updateCurrentTrace, addToolCall, updateToolCall, setActivePanel } = get();
    const target = opts?.target ?? 'incident-agent';
    const lookback = opts?.lookback ?? 25;
    const datasetId = builderDatasetId ?? `${target}-cases`;
    const datasetType = builderDatasetType ?? 'flow';

    // Push trace into the Live Trace panel so the user sees what's happening
    resetCurrentTrace();
    updateCurrentTrace({ isStreaming: true, routeDecision: { agent: 'eval-proposer', model: '', mechanism: 'Analyzing runs for proposals' } });
    setActivePanel('chat-trace');

    try {
      const res = await fetch(`${backendUrl}/api/eval-proposer/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, datasetId, datasetType, lookback, maxCandidates: 10 }),
      });
      if (!res.ok) {
        console.error('loadProposedCandidates failed:', res.status);
        updateCurrentTrace({ isStreaming: false });
        return [];
      }

      const reader = res.body?.getReader();
      if (!reader) { updateCurrentTrace({ isStreaming: false }); return []; }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = '';
      let finalCandidates: Candidate[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEventType = trimmed.slice(7).trim();
            continue;
          }
          if (trimmed.startsWith(': ') || trimmed === ':' || trimmed === '') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));

            if (currentEventType === 'route_decision' && json.kind === 'route') {
              updateCurrentTrace({
                routeDecision: {
                  agent: json.agent ?? 'eval-proposer',
                  model: '',
                  mechanism: json.detail ?? '',
                },
              });
              currentEventType = '';
              continue;
            }

            if (currentEventType === 'langfuse' && json.kind === 'langfuse') {
              updateCurrentTrace({ langfuseUrl: json.langfuseUrl ?? null });
              currentEventType = '';
              continue;
            }

            // agent start event — informational, update trace status
            if (currentEventType === 'tool_call' && json.kind === 'agent') {
              updateCurrentTrace({ isStreaming: true });
              currentEventType = '';
              continue;
            }

            if (currentEventType === 'tool_call' && json.kind === 'tool') {
              addToolCall({
                id: json.callId ?? crypto.randomUUID(),
                name: json.tool ?? 'unknown',
                args: json.args ?? {},
                source: json.source,
                durationMs: 0,
                timestamp: Date.now(),
              });
              currentEventType = '';
              continue;
            }

            if (currentEventType === 'tool_call' && json.kind === 'tool_result') {
              if (json.callId) {
                updateToolCall(json.callId, {
                  result: json.result,
                  durationMs: Date.now() - (get().currentTrace.toolCalls.find(tc => tc.id === json.callId)?.timestamp ?? Date.now()),
                });
              }
              currentEventType = '';
              continue;
            }

            if (currentEventType === 'result' && json.candidates) {
              finalCandidates = json.candidates as Candidate[];
              currentEventType = '';
              continue;
            }

            if (currentEventType === 'error') {
              console.error('Proposer error:', json.error);
              updateCurrentTrace({ isStreaming: false });
              return [];
            }
          } catch {
            // skip malformed JSON
          }
        }
      }

      updateCurrentTrace({ isStreaming: false });

      const cands = finalCandidates.map((c) => ({ ...c, source: 'proposed' as const }));
      if (cands.length > 0) addCandidates(cands);
      return cands;
    } catch (err) {
      console.error('loadProposedCandidates failed:', err);
      updateCurrentTrace({ isStreaming: false });
      return [];
    }
  },

  generateVariations: async (seedCaseId: string, n: number) => {
    const { backendUrl, candidates, addCandidates } = get();
    const seedCand = candidates.find((c) => c.case.id === seedCaseId);
    if (!seedCand) return;
    const seedText = (seedCand.case.request as string) ?? (seedCand.case.input as string) ?? '';
    if (!seedText.trim()) return;
    try {
      const res = await fetch(`${backendUrl}/api/datasets/variations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: seedText, n, datasetType: seedCand.datasetType }),
      });
      if (!res.ok) return;
      const data = await res.json() as { variations: string[] };
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const baseCase = seedCand.case;
      const varCands: Candidate[] = (data.variations ?? []).map((v, i) => ({
        candidateId: `cand-var-${stamp}-${i}`,
        datasetId: seedCand.datasetId,
        datasetType: seedCand.datasetType,
        source: 'variation' as const,
        sourceRef: seedCaseId,
        status: 'pending' as const,
        case: seedCand.datasetType === 'router'
          ? { ...baseCase, id: `variation-${stamp}-${i}`, request: v }
          : { ...baseCase, id: `variation-${stamp}-${i}`, input: v },
      }));
      addCandidates(varCands);
    } catch (err) {
      console.error('generateVariations failed:', err);
    }
  },

  sendRunsToTray: (runIds: string[]) => {
    const { runs, addCandidates } = get();
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const cands: Candidate[] = runs
      .filter((r) => runIds.includes(r.id) && r.selected_route_id)
      .map((r) => {
        const datasetId = r.selected_route_id === 'routing-cases' || true
          ? 'routing-cases'
          : `${r.selected_route_id}-cases`;
        const isFailed = r.status === 'failed';
        return {
          candidateId: `cand-run-${r.id}`,
          datasetId,
          datasetType: 'router' as const,
          source: 'run' as const,
          sourceRef: r.id,
          status: 'pending' as const,
          case: {
            id: `run-${isFailed ? 'regression' : 'capture'}-${stamp}-${r.id.slice(0, 8)}`,
            request: r.original_request,
            expectedAgent: r.selected_route_id!,
            regression: isFailed,
            sourceRunId: r.id,
            note: isFailed ? (r.response_preview ?? 'failed') : undefined,
          },
        };
      });
    addCandidates(cands);
  },

  // Phase 3: dataset management
  datasetList: [],
  selectedDatasetId: null,
  datasetCases: [],
  datasetCoverage: null,

  fetchDatasets: async () => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/datasets`);
      if (!res.ok) return;
      const data = await res.json() as { datasets: DatasetSummary[] };
      set({ datasetList: data.datasets ?? [] });
    } catch { /* non-critical */ }
  },

  setSelectedDatasetId: (id) => set({ selectedDatasetId: id }),

  fetchDatasetCases: async (datasetId) => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${datasetId}`);
      if (!res.ok) return;
      const data = await res.json() as { cases?: Record<string, unknown>[] };
      set({ datasetCases: (data.cases ?? []) as Record<string, unknown>[] });
    } catch { /* non-critical */ }
  },

  fetchDatasetCoverage: async (datasetId) => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${datasetId}/coverage`);
      if (!res.ok) return;
      const data = await res.json() as DatasetCoverage;
      set({ datasetCoverage: data });
    } catch { /* non-critical */ }
  },

  deleteDatasetCase: async (datasetId, caseId) => {
    const { backendUrl, datasetCases } = get();
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${datasetId}/cases/${encodeURIComponent(caseId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return;
      set({ datasetCases: datasetCases.filter((c) => c.id !== caseId) });
    } catch { /* non-critical */ }
  },

  fillGap: (datasetId, agent) => {
    const { addManualCandidate } = get();
    addManualCandidate({
      caseFields: {
        id: `gap-${agent}-${Date.now()}`,
        request: `Request for ${agent}`,
        expectedAgent: agent,
        regression: false,
      },
      datasetId,
      datasetType: 'router',
    });
  },

  fetchRuns: async (sessionId?: string) => {
    const { backendUrl } = get();
    try {
      const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}&limit=50` : "?limit=50";
      const res = await fetch(`${backendUrl}/api/runs${params}`);
      if (!res.ok) return;
      const data = await res.json();
      set({ runs: (data as { runs: RunSummary[] }).runs ?? [] });
    } catch {
      // Non-critical
    }
  },

  loadRunTrace: async (runId: string) => {
    const { backendUrl } = get();
    try {
      const res = await fetch(`${backendUrl}/api/runs/${runId}`);
      if (!res.ok) return;
      const run = await res.json() as {
        original_request: string;
        final_response: string | null;
        selected_route_id: string | null;
        route_confidence: number | null;
        route_reason: string | null;
        error: string | null;
        status: string;
        durationMs: number | null;
      };

      const trace: TraceState = {
        mermaidDiagram: null,
        toolCalls: [],
        routeDecision: run.selected_route_id
          ? {
              agent: run.selected_route_id,
              model: "",
              mechanism: run.route_reason ?? `confidence: ${((run.route_confidence ?? 0) * 100).toFixed(0)}%`,
            }
          : null,
        isStreaming: false,
        langfuseUrl: null,
      };

      set({ selectedRunTrace: trace, showRunHistory: false });
    } catch {
      // Non-critical
    }
  },

  setShowRunHistory: (v) => set({ showRunHistory: v }),

  // Phase 4: Push an eval result trace to the TracePanel for replay
  pushEvalTrace: (params: { label: string; routeAgent: string; mechanism: string; toolCalls?: ToolCallEvent[] }) => {
    const trace: TraceState = {
      mermaidDiagram: null,
      toolCalls: params.toolCalls ?? [],
      routeDecision: {
        agent: params.routeAgent,
        model: '',
        mechanism: params.mechanism,
      },
      isStreaming: false,
      langfuseUrl: null,
    };
    set({ selectedRunTrace: trace, showRunHistory: false, activePanel: "chat-trace" });
  },

  // Phase 5: Save eval result to bench shelf
  saveEvalToShelf: (params) => {
    const state = get();
    const artifact = {
      id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: params.name,
      kind: 'eval-run' as const,
      spec: {
        inputs: [{ name: 'axString', type: 'string' as const }, { name: 'metric', type: 'string' as const }],
        outputs: [{ name: 'accuracy', type: 'number' as const }, { name: 'hits', type: 'number' as const }, { name: 'total', type: 'number' as const }],
      },
      axString: params.axString,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _evalMeta: { accuracy: params.accuracy, hits: params.hits, total: params.total, metric: params.metric },
    };
    state.saveArtifact(artifact as any);
  },
}));
