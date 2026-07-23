"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  FlaskConical,
  Play,
  Loader2,
  X,
  Target,
  List,
  ExternalLink,
  Code2,
  GitBranch,
  Route,
  BookOpen,
  Plus,
  Trash2,
  History,
  Bot,
  Clock,
} from "lucide-react";
import { useLabStore } from "@/lib/store";
import type { EvalMode } from "@/lib/store";
import type { BenchArtifact, SigField } from "@/lib/bench";

// --- Router eval types (existing) ---
interface EvalCase {
  id: string;
  expectedAgent: string;
  request: string;
}

interface EvalResult {
  id: string;
  request: string;
  expectedAgent: string;
  selectedAgent: string;
  score: number;
}

interface EvalSummary {
  total: number;
  hits: number;
  accuracy: number;
  byLabel: Record<string, { hit: number; n: number }>;
  misses: Array<{ id: string; expected: string; got: string; request: string }>;
}

const DEMO_SUMMARY: EvalSummary = {
  total: 57, hits: 49, accuracy: 0.86,
  byLabel: {
    scribe: { hit: 7, n: 8 }, seeker: { hit: 7, n: 8 }, sorter: { hit: 8, n: 8 },
    architect: { hit: 5, n: 6 }, connector: { hit: 4, n: 4 }, librarian: { hit: 6, n: 7 },
    conductor: { hit: 5, n: 6 }, scout: { hit: 3, n: 4 }, clarify: { hit: 4, n: 6 },
  },
  misses: [
    { id: "s-17", expected: "seeker", got: "librarian", request: "find notes about vault consistency" },
    { id: "s-23", expected: "scribe", got: "conductor", request: "record this: need CI for agent tests" },
    { id: "s-31", expected: "librarian", got: "seeker", request: "are there broken links in my vault" },
    { id: "s-42", expected: "architect", got: "sorter", request: "set up a new project area for quant" },
    { id: "s-45", expected: "clarify", got: "seeker", request: "what about the thing" },
    { id: "s-48", expected: "scout", got: "seeker", request: "what open source repos handle agent tracing" },
    { id: "s-51", expected: "scribe", got: "sorter", request: "draft a note about the new proxy setup" },
    { id: "s-55", expected: "clarify", got: "conductor", request: "system" },
  ],
};

interface RouterSuiteData { cases: EvalCase[]; }

// --- Flow eval types ---
interface FlowCase {
  id: string;
  input: unknown;
  expected?: Record<string, unknown>;
  metric?: string;
}

interface FlowDataset {
  id: string;
  type: "router" | "flow";
  file: string;
  caseCount?: number;
  targetId?: string;
  description?: string | null;
}

interface FlowEvalResult {
  caseId: string;
  output?: unknown;
  finalResponse?: string;
  score: number;
  durationMs: number;
  error?: string;
}

interface FlowEvalSummary { hits: number; total: number; accuracy: number; }

interface SignatureCaseDraft {
  id: string;
  inputText: string;
  expectedText: string;
}

interface SignatureEvalResult {
  input: Record<string, unknown>;
  output?: unknown;
  expected?: Record<string, unknown>;
  pass?: boolean;
  score?: number;
  error?: string;
}

interface SignatureEvalSummary {
  total: number;
  labeled: number;
  hits: number;
  accuracy: number;
}

interface SignatureEvalResponse {
  results: SignatureEvalResult[];
  summary: SignatureEvalSummary;
}

interface SignatureOptimizeResult {
  before: { hits: number; total: number; pct: string };
  after: { hits: number; total: number; pct: string };
  delta: number;
  trainCases: number;
  validationCases: number;
  optimizedProgram: unknown;
}

function nextDraftId(): string {
  return `sig-case-${Math.random().toString(36).slice(2, 10)}`;
}

function sampleValue(field: SigField): unknown {
  switch (field.type) {
    case "number":
    case "number[]":
      return field.type === "number[]" ? [0] : 0;
    case "boolean":
      return false;
    case "json":
      return { example: true };
    case "date":
      return "2026-07-22";
    case "datetime":
      return "2026-07-22T12:00:00Z";
    case "dateRange":
      return ["2026-07-22", "2026-07-23"];
    case "datetimeRange":
      return ["2026-07-22T12:00:00Z", "2026-07-22T13:00:00Z"];
    case "url":
      return "https://example.com";
    case "code":
      return "return true;";
    case "class":
      return field.classValues?.[0] ?? "";
    case "string[]":
      return [field.name || "example"];
    case "string":
    default:
      return field.name || "example";
  }
}

function makeSampleInput(artifact: BenchArtifact): Record<string, unknown> {
  return Object.fromEntries(
    artifact.spec.inputs.map((field) => [field.name || "field", sampleValue(field)]),
  );
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type DatasetKindFilter = "all" | "router" | "flow";

interface DatasetDetail {
  id: string;
  type: "router" | "flow";
  flowId?: string;
  description?: string | null;
  cases: Array<Record<string, unknown>>;
}

function AccuracyBar({ accuracy, hits, total }: { accuracy: number; hits: number; total: number }) {
  return (
    <div className="bg-ax-bg border border-ax-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-ax-text">Accuracy</span>
        <span className="text-sm font-mono text-ax-accent">{hits}/{total} ({(accuracy * 100).toFixed(0)}%)</span>
      </div>
      <div className="h-2 bg-ax-surface rounded-full overflow-hidden">
        <div className="h-full bg-ax-success rounded-full transition-all duration-500" style={{ width: `${accuracy * 100}%` }} />
      </div>
    </div>
  );
}

function MetricEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-ax-text-dim uppercase">Metric Function</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-ax-bg border border-ax-border rounded-lg p-2 text-xs text-ax-text font-mono resize-y min-h-[80px]"
        placeholder="function score(output, expected) { return output.x === expected.x ? 1 : 0; }"
      />
    </div>
  );
}

export function EvalPanel() {
  const {
    backendUrl,
    isConnected,
    pushToNotebook,
    pushEvalTrace,
    saveEvalToShelf,
    evalMode,
    setEvalMode,
    evalTarget,
    getArtifact,
    bench,
  } = useLabStore();
  const [suite, setSuite] = useState<RouterSuiteData | null>(null);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCases, setSelectedCases] = useState<number>(10);
  const [status, setStatus] = useState("");
  const [showCaseList, setShowCaseList] = useState(false);
  const [caseFilter, setCaseFilter] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<FlowDataset[]>([]);
  const [datasetFilter, setDatasetFilter] = useState<DatasetKindFilter>("all");
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [datasetDraftJson, setDatasetDraftJson] = useState("");
  const [datasetSaveStatus, setDatasetSaveStatus] = useState("");
  const [selectedFlowId, setSelectedFlowId] = useState<string>("braindump-triage");
  const [flowCases, setFlowCases] = useState<FlowCase[]>([]);
  const [metricTemplates, setMetricTemplates] = useState<Array<{ flowId: string; label: string; metric: string; checks: string[] }>>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [flowMetric, setFlowMetric] = useState(
    "function score(output, expected) {\n  const items = output?.output?.items ?? [];\n  return items.length === expected?.itemCount ? 1.0 : 0.0;\n}"
  );
  const [flowResults, setFlowResults] = useState<FlowEvalResult[] | null>(null);
  const [flowSummary, setFlowSummary] = useState<FlowEvalSummary | null>(null);
  const [selectedFlowCases, setSelectedFlowCases] = useState<number>(10);
  const [signatureCases, setSignatureCases] = useState<SignatureCaseDraft[]>([]);
  const [signatureResults, setSignatureResults] = useState<SignatureEvalResponse | null>(null);
  const [signatureOptimizeResult, setSignatureOptimizeResult] = useState<SignatureOptimizeResult | null>(null);
  const [customAxString, setCustomAxString] = useState('');
  const [customCases, setCustomCases] = useState<Array<{ id: string; input: any; expected?: any }>>([]);
  const [customMetric, setCustomMetric] = useState(
    'function score(output, expected) {\n  // field-by-field exact match\n  return JSON.stringify(output) === JSON.stringify(expected) ? 1 : 0;\n}'
  );
  const [customResults, setCustomResults] = useState<FlowEvalResult[] | null>(null);
  const [customSummary, setCustomSummary] = useState<FlowEvalSummary | null>(null);
  const [customSelectedCases, setCustomSelectedCases] = useState<number>(10);
  const [customOptimizeResult, setCustomOptimizeResult] = useState<{ before: { hits: number; total: number; pct: string }; after: { hits: number; total: number; pct: string }; delta: number } | null>(null);
  const [experiments, setExperiments] = useState<Array<{
    id: string;
    program_hash: string;
    target_type: string;
    target_id: string | null;
    ax_string: string;
    metric: string | null;
    created_at: string;
    latest_run: { id: string; mode: string; accuracy: number; hits: number; total: number; created_at: string } | null;
    run_count: number;
  }>>([]);
  const [showExperimentHistory, setShowExperimentHistory] = useState(false);
  const [datasetsExpanded, setDatasetsExpanded] = useState(false);

  // --- Agent eval state (Phase 3) ---
  const [agentId, setAgentId] = useState('seeker');
  const [agentCases, setAgentCases] = useState<Array<{ id: string; prompt: string; expected?: string }>>([
    { id: 'agent-case-1', prompt: '' },
  ]);
  const [agentMetric, setAgentMetric] = useState('return output.includes(expected) ? 1 : 0');
  const [agentResults, setAgentResults] = useState<Array<{ caseId: string; output?: string; error?: string; score?: number; durationMs: number }> | null>(null);
  const [agentSummary, setAgentSummary] = useState<{ hits: number; total: number; labeled: number; accuracy: number } | null>(null);
  const [agentSelectedCases, setAgentSelectedCases] = useState(5);
  const [importStatus, setImportStatus] = useState('');
  const [compareSelection, setCompareSelection] = useState<Array<{ expId: string; runId: string; accuracy: number; hits: number; total: number }>>([]);
  const [signatureBudget, setSignatureBudget] = useState(20);
  const [signatureMetric, setSignatureMetric] = useState(`// Default: field-by-field exact match against expected
const { scoreExpectedKeys } = (() => {
  function scoreExpectedKeys(actual, expected) {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return { matched: 0, total: expected.length || 1 };
      return expected.reduce((acc, item, i) => {
        const n = scoreExpectedKeys(actual[i], item);
        return { matched: acc.matched + n.matched, total: acc.total + n.total };
      }, { matched: 0, total: expected.length || 1 });
    }
    if (expected !== null && typeof expected === 'object') {
      const entries = Object.entries(expected);
      if (entries.length === 0) return { matched: 1, total: 1 };
      if (!actual || typeof actual !== 'object') return { matched: 0, total: entries.length };
      return entries.reduce((acc, [key, value]) => {
        const n = scoreExpectedKeys(actual[key], value);
        return { matched: acc.matched + n.matched, total: acc.total + n.total };
      }, { matched: 0, total: 0 });
    }
    return { matched: Object.is(actual, expected) ? 1 : 0, total: 1 };
  }
  return { scoreExpectedKeys };
})();

const s = scoreExpectedKeys(output, expected);
return s.total === 0 ? 0 : s.matched / s.total;`);
  const [loadedSignatureId, setLoadedSignatureId] = useState<string | null>(null);

  const signatureArtifact =
    evalTarget?.kind === "signature" ? getArtifact(evalTarget.artifactId) ?? null : null;

  useEffect(() => {
    if (!isConnected) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${backendUrl}/api/datasets`);
        const payload = await res.json();
        const baseDatasets: FlowDataset[] = payload.datasets ?? [];

        const enriched = await Promise.all(
          baseDatasets.map(async (dataset) => {
            try {
              const detailRes = await fetch(`${backendUrl}/api/datasets/${dataset.id}`);
              const detail = await detailRes.json();
              return {
                ...dataset,
                caseCount: Array.isArray(detail.cases) ? detail.cases.length : 0,
                targetId: detail.flowId ?? "router",
                description: detail.description ?? null,
              } satisfies FlowDataset;
            } catch {
              return dataset;
            }
          }),
        );

        if (!cancelled) {
          setDatasets(enriched);
        }
      } catch {
        if (!cancelled) {
          setDatasets([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, backendUrl]);

  // Fetch metric templates (9A)
  useEffect(() => {
    if (!isConnected) return;
    fetch(`${backendUrl}/api/metrics/templates`)
      .then((r) => r.json())
      .then((d) => {
        if (d.templates) setMetricTemplates(d.templates);
      })
      .catch(() => {});
  }, [isConnected, backendUrl]);

  // Auto-apply metric template when switching flows
  useEffect(() => {
    const tpl = metricTemplates.find((t) => t.flowId === selectedFlowId);
    if (tpl) {
      setFlowMetric(tpl.metric);
      setActiveTemplateId(String(tpl.flowId));
    }
  }, [selectedFlowId, metricTemplates]);

  // Auto-load dataset when switching flow (Phase 2: dataset-target linking)
  useEffect(() => {
    if (evalMode !== 'flow' || !isConnected || !datasets.length) return;
    const matchingDataset = datasets.find(
      (d) => d.targetId === selectedFlowId || d.id === `${selectedFlowId}-cases`
    );
    if (matchingDataset) {
      loadFlowDataset(matchingDataset.id);
    }
  }, [selectedFlowId, evalMode, isConnected, datasets.length]);

  const fetchDatasetDetail = useCallback(async (datasetId: string): Promise<DatasetDetail> => {
    const res = await fetch(`${backendUrl}/api/datasets/${datasetId}`);
    const data = await res.json();
    return {
      id: datasetId,
      type: (data.type ?? (datasetId === "routing-cases" ? "router" : "flow")) as "router" | "flow",
      flowId: data.flowId,
      description: data.description ?? null,
      cases: Array.isArray(data.cases) ? data.cases : [],
    };
  }, [backendUrl]);

  const loadDatasetDraft = useCallback(async (datasetId: string) => {
    const detail = await fetchDatasetDetail(datasetId);
    setSelectedDatasetId(datasetId);
    setDatasetDraftJson(
      JSON.stringify(
        {
          ...(detail.flowId ? { flowId: detail.flowId } : {}),
          ...(detail.description ? { description: detail.description } : {}),
          cases: detail.cases,
        },
        null,
        2,
      ),
    );
    setDatasetSaveStatus("");
    return detail;
  }, [fetchDatasetDetail]);

  useEffect(() => {
    if (signatureArtifact && evalMode !== "signature") {
      setEvalMode("signature");
    }
  }, [signatureArtifact, evalMode, setEvalMode]);

  const loadSuite = useCallback(async () => {
    if (!isConnected) {
      setStatus("Demo mode");
      return;
    }
    setIsLoading(true);
    try {
      const detail = await loadDatasetDraft("routing-cases");
      setSuite({ cases: detail.cases as unknown as EvalCase[] });
      setStatus(`Loaded ${detail.cases.length} cases`);
      setShowCaseList(true);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [isConnected, loadDatasetDraft]);

  useEffect(() => {
    if (!signatureArtifact || signatureArtifact.id === loadedSignatureId) return;
    setSignatureCases([
      {
        id: nextDraftId(),
        inputText: formatJson(makeSampleInput(signatureArtifact)),
        expectedText: "",
      },
    ]);
    setSignatureResults(null);
    setSignatureOptimizeResult(null);
    setLoadedSignatureId(signatureArtifact.id);
    setStatus(`Loaded signature target: ${signatureArtifact.name}`);
  }, [signatureArtifact, loadedSignatureId]);


  const runRouterEval = useCallback(async () => {
    if (!isConnected) {
      setSummary(DEMO_SUMMARY);
      setStatus("Demo results");
      return;
    }
    if (!suite) return;
    setIsLoading(true);
    setShowCaseList(false);
    try {
      const sample = suite.cases.slice(0, selectedCases);
      const res = await fetch(`${backendUrl}/api/eval/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases: sample }),
      });
      const data = await res.json();
      setSummary(data.summary);
      setStatus(
        `Complete: ${data.summary.hits}/${data.summary.total} (${(data.summary.accuracy * 100).toFixed(0)}%)`,
      );
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [isConnected, backendUrl, suite, selectedCases]);

  const loadFlowDataset = useCallback(async (datasetId: string) => {
    setIsLoading(true);
    try {
      const detail = await loadDatasetDraft(datasetId);
      setFlowCases(detail.cases as unknown as FlowCase[]);
      const firstMetric = (detail.cases[0] as { metric?: string } | undefined)?.metric;
      if (firstMetric) setFlowMetric(firstMetric);
      setStatus(`Loaded ${detail.cases.length} flow cases`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [loadDatasetDraft]);

  const runFlowEval = useCallback(async () => {
    if (!flowCases.length) return;
    setIsLoading(true);
    setFlowResults(null);
    try {
      const sample = flowCases.slice(0, selectedFlowCases);
      const res = await fetch(`${backendUrl}/api/eval/flow-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId: selectedFlowId,
          cases: sample.map((testCase) => ({ ...testCase, metric: flowMetric })),
        }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";
      const results: FlowEvalResult[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) continue;
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.caseId) {
              results.push(ev);
              setFlowResults([...results]);
            }
            if (ev.hits !== undefined) {
              setFlowSummary(ev);
              setStatus(`Complete: ${ev.hits}/${ev.total} (${(ev.accuracy * 100).toFixed(0)}%)`);
            }
          } catch {
            // Ignore malformed event rows.
          }
        }
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [flowCases, selectedFlowCases, selectedFlowId, flowMetric, backendUrl]);

  const openDatasetInNotebook = useCallback(async (datasetId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${datasetId}`);
      const data = await res.json();
      pushToNotebook(`// Dataset: ${datasetId}\nconst dataset = ${JSON.stringify(data, null, 2)};\ndataset;`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed to open dataset"}`);
    }
  }, [backendUrl, pushToNotebook]);

  const downloadDataset = useCallback(async (datasetId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${datasetId}/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${datasetId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* non-critical */ }
  }, [backendUrl]);

  const importDataset = useCallback(async (jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText) as { id?: string; type?: string; flowId?: string; description?: string; cases?: unknown[] };
      if (!parsed.id || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
        setImportStatus('Invalid dataset: id and non-empty cases array required');
        return;
      }
      const res = await fetch(`${backendUrl}/api/datasets/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImportStatus(`Imported ${data.id} (${data.caseCount} cases)`);
      // Refresh dataset list
      const listRes = await fetch(`${backendUrl}/api/datasets`);
      const listData = await listRes.json();
      const baseDatasets: FlowDataset[] = listData.datasets ?? [];
      const enriched = await Promise.all(baseDatasets.map(async (dataset) => {
        const detailRes = await fetch(`${backendUrl}/api/datasets/${dataset.id}`);
        const detail = await detailRes.json();
        return {
          ...dataset,
          caseCount: Array.isArray(detail.cases) ? detail.cases.length : 0,
          targetId: detail.flowId ?? 'router',
          description: detail.description ?? null,
        } satisfies FlowDataset;
      }));
      setDatasets(enriched);
    } catch (e) {
      setImportStatus(`Import error: ${e instanceof Error ? e.message : 'Failed'}`);
    }
  }, [backendUrl]);

  const loadDatasetIntoMode = useCallback(async (dataset: FlowDataset) => {
    if (dataset.type === "router") {
      setEvalMode("router");
      const detail = await loadDatasetDraft(dataset.id);
      setSuite({ cases: detail.cases as unknown as EvalCase[] });
      setShowCaseList(true);
      setStatus(`Loaded ${detail.cases.length} router cases`);
      return;
    }

    if (dataset.id === "routing-cases") {
      setEvalMode("router");
      const detail = await loadDatasetDraft(dataset.id);
      setSuite({ cases: detail.cases as unknown as EvalCase[] });
      setShowCaseList(true);
      setStatus(`Loaded ${detail.cases.length} router cases`);
      return;
    }

    // Phase 2: If dataset has a flow targetId, route to Flow eval mode
    if (dataset.type === "flow" && dataset.targetId) {
      setEvalMode("flow");
      setSelectedFlowId(dataset.targetId);
      await loadFlowDataset(dataset.id);
      return;
    }

    // Load into Custom mode by default for untyped/untargeted datasets
    const detail = await fetchDatasetDetail(dataset.id);
    setCustomCases(detail.cases as unknown as Array<{ id: string; input: any; expected?: any }>);
    setEvalMode("custom");
    setStatus(`Loaded ${detail.cases.length} cases for custom eval`);
  }, [loadDatasetDraft, loadFlowDataset, fetchDatasetDetail, setEvalMode]);

  // Custom program eval handlers
  const loadCustomDataset = useCallback(async (datasetId: string) => {
    const detail = await fetchDatasetDetail(datasetId);
    setCustomCases(detail.cases as unknown as Array<{ id: string; input: any; expected?: any }>);
    setStatus(`Loaded ${detail.cases.length} cases`);
  }, [fetchDatasetDetail]);

  const runCustomEval = useCallback(async () => {
    if (!customAxString.trim()) { setStatus('Enter an ax signature first'); return; }
    if (!customCases.length) { setStatus('Load a dataset first'); return; }
    setIsLoading(true);
    setCustomResults(null);
    try {
      const sample = customCases.slice(0, customSelectedCases);
      const res = await fetch(`${backendUrl}/api/eval/program-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axString: customAxString, cases: sample, metric: customMetric }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');
      const decoder = new TextDecoder();
      let buffer = '';
      const results: FlowEvalResult[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event: ')) continue;
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.caseId) {
              results.push(ev);
              setCustomResults([...results]);
            }
            if (ev.hits !== undefined) {
              setCustomSummary(ev);
              setStatus(`Complete: ${ev.hits}/${ev.labeled ?? ev.total} (${(ev.accuracy * 100).toFixed(0)}%)`);
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Failed'}`);
    }
    setIsLoading(false);
  }, [customAxString, customCases, customSelectedCases, customMetric, backendUrl]);

  const runCustomOptimize = useCallback(async () => {
    if (!customAxString.trim()) { setStatus('Enter an ax signature first'); return; }
    if (!customCases.length) { setStatus('Load a dataset first'); return; }
    const labeled = customCases.filter(c => isPlainObject(c.expected));
    if (labeled.length < 2) { setStatus('At least two labeled cases required'); return; }
    setIsLoading(true);
    try {
      const res = await fetch(`${backendUrl}/api/eval/program-optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axString: customAxString, cases: customCases, metric: customMetric, maxMetricCalls: 20 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCustomOptimizeResult(data);
      setStatus(`Optimize complete: ${data.before.hits}/${data.before.total} → ${data.after.hits}/${data.after.total}`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Failed'}`);
    }
    setIsLoading(false);
  }, [customAxString, customCases, customMetric, backendUrl]);

  // --- Agent eval handlers (Phase 3) ---
  const addAgentCase = useCallback(() => {
    setAgentCases(c => [...c, { id: `agent-case-${c.length + 1}`, prompt: '' }]);
  }, []);

  const updateAgentCase = useCallback((id: string, patch: Partial<{ prompt: string; expected?: string }>) => {
    setAgentCases(c => c.map(tc => tc.id === id ? { ...tc, ...patch } : tc));
  }, []);

  const removeAgentCase = useCallback((id: string) => {
    setAgentCases(c => c.length > 1 ? c.filter(tc => tc.id !== id) : c);
  }, []);

  const runAgentEval = useCallback(async () => {
    const cases = agentCases.filter(c => c.prompt.trim());
    if (!cases.length) { setStatus('Add at least one prompt'); return; }
    setIsLoading(true);
    setAgentResults(null);
    setAgentSummary(null);
    try {
      const sample = cases.slice(0, agentSelectedCases > 0 ? agentSelectedCases : cases.length);
      const res = await fetch(`${backendUrl}/api/eval/agent-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, cases: sample, metric: agentMetric }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');
      const decoder = new TextDecoder();
      let buffer = '';
      const results: typeof agentResults = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event: ')) continue;
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.caseId) {
              results!.push(ev);
              setAgentResults([...results!]);
            }
            if (ev.hits !== undefined) {
              setAgentSummary(ev);
              setStatus(`Agent eval: ${ev.hits}/${ev.labeled} (${(ev.accuracy * 100).toFixed(0)}%)`);
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'Failed'}`);
    }
    setIsLoading(false);
  }, [agentCases, agentSelectedCases, agentId, agentMetric, backendUrl]);

  // Quick-load from bench shelf
  const quickLoadFromBench = useCallback((artifactId: string) => {
    const artifact = bench.find(a => a.id === artifactId);
    if (artifact?.kind === 'signature') {
      setCustomAxString(artifact.axString);
      setStatus(`Loaded signature: ${artifact.name}`);
    }
  }, [bench]);

  // Experiment history
  const fetchExperiments = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/api/eval/experiments`);
      const data = await res.json();
      if (data.experiments) setExperiments(data.experiments);
    } catch { /* non-critical */ }
  }, [backendUrl]);

  const loadExperiment = useCallback((exp: typeof experiments[0]) => {
    setCustomAxString(exp.ax_string);
    if (exp.metric) setCustomMetric(exp.metric);
    setEvalMode('custom');
    setShowExperimentHistory(false);
    setStatus(`Loaded experiment: ${exp.ax_string.slice(0, 50)}...`);
  }, [setEvalMode]);

  // Auto-refresh experiments after a run
  useEffect(() => {
    if (customSummary || customOptimizeResult) {
      fetchExperiments();
    }
  }, [customSummary, customOptimizeResult, fetchExperiments]);

  const addDraftCase = useCallback(() => {
    if (!selectedDatasetId) return;
    try {
      const parsed = JSON.parse(datasetDraftJson || '{"cases": []}') as Record<string, unknown>;
      const cases = Array.isArray(parsed.cases) ? [...parsed.cases] as Array<Record<string, unknown>> : [];
      const nextIndex = cases.length + 1;
      const isRouter = selectedDatasetId === "routing-cases";
      const caseId = `${selectedDatasetId.replace(/-cases$/, "")}-${String(nextIndex).padStart(2, "0")}`;
      cases.push(
        isRouter
          ? { id: caseId, request: "", expectedAgent: "seeker" }
          : {
              id: caseId,
              input: "",
              expected: {},
              metric: "function score(output, expected) {\n  return 1.0;\n}",
            },
      );
      setDatasetDraftJson(JSON.stringify({ ...parsed, cases }, null, 2));
      setDatasetSaveStatus("");
    } catch (error) {
      setDatasetSaveStatus(error instanceof Error ? error.message : "Could not add case");
    }
  }, [datasetDraftJson, selectedDatasetId]);

  const deleteDraftCase = useCallback(async (caseId: string) => {
    if (!selectedDatasetId) return;
    try {
      const res = await fetch(`${backendUrl}/api/datasets/${selectedDatasetId}/cases/${encodeURIComponent(caseId)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Delete failed: ${res.status}`);
      }
      const detail = await loadDatasetDraft(selectedDatasetId);
      if (selectedDatasetId === "routing-cases") {
        setSuite({ cases: detail.cases as unknown as EvalCase[] });
      } else {
        setFlowCases(detail.cases as unknown as FlowCase[]);
      }
      setDatasetSaveStatus(`Deleted ${caseId}`);
    } catch (error) {
      setDatasetSaveStatus(error instanceof Error ? error.message : "Delete failed");
    }
  }, [backendUrl, loadDatasetDraft, selectedDatasetId]);

  const saveDatasetDraft = useCallback(async () => {
    if (!selectedDatasetId) return;
    try {
      const parsed = JSON.parse(datasetDraftJson || '{"cases": []}') as Record<string, unknown>;
      const res = await fetch(`${backendUrl}/api/datasets/${selectedDatasetId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Save failed: ${res.status}`);
      }

      const detail = await loadDatasetDraft(selectedDatasetId);
      setDatasetSaveStatus(`Saved ${selectedDatasetId} (${data.caseCount ?? detail.cases.length} cases)`);
      setDatasets((current) =>
        current.map((dataset) =>
          dataset.id === selectedDatasetId
            ? { ...dataset, caseCount: detail.cases.length, description: detail.description ?? null, targetId: detail.flowId ?? dataset.targetId }
            : dataset,
        ),
      );

      if (selectedDatasetId === "routing-cases") {
        setSuite({ cases: detail.cases as unknown as EvalCase[] });
      } else {
        setFlowCases(detail.cases as unknown as FlowCase[]);
      }
    } catch (error) {
      setDatasetSaveStatus(error instanceof Error ? error.message : "Save failed");
    }
  }, [backendUrl, datasetDraftJson, loadDatasetDraft, selectedDatasetId]);

  const updateSignatureCase = useCallback(
    (id: string, patch: Partial<SignatureCaseDraft>) => {
      setSignatureCases((current) =>
        current.map((testCase) => (testCase.id === id ? { ...testCase, ...patch } : testCase)),
      );
    },
    [],
  );

  const addSignatureCase = useCallback(() => {
    setSignatureCases((current) => [
      ...current,
      { id: nextDraftId(), inputText: "{}", expectedText: "" },
    ]);
  }, []);

  const removeSignatureCase = useCallback((id: string) => {
    setSignatureCases((current) =>
      current.length > 1 ? current.filter((testCase) => testCase.id !== id) : current,
    );
  }, []);

  const parseSignatureCases = useCallback(() => {
    return signatureCases.map((testCase, index) => {
      let input: unknown;
      let expected: unknown = undefined;
      try {
        input = JSON.parse(testCase.inputText || "{}");
      } catch {
        throw new Error(`Case ${index + 1}: input is not valid JSON`);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`Case ${index + 1}: input must be a JSON object`);
      }
      if (testCase.expectedText.trim()) {
        try {
          expected = JSON.parse(testCase.expectedText);
        } catch {
          throw new Error(`Case ${index + 1}: expected is not valid JSON`);
        }
        if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
          throw new Error(`Case ${index + 1}: expected must be a JSON object`);
        }
      }
      return {
        input: input as Record<string, unknown>,
        expected: expected as Record<string, unknown> | undefined,
      };
    });
  }, [signatureCases]);

  const runSignatureEval = useCallback(async () => {
    if (!signatureArtifact) {
      setStatus("Send a signature from Builder first");
      return;
    }
    if (!isConnected) {
      setStatus("Backend unavailable");
      return;
    }
    setIsLoading(true);
    setSignatureOptimizeResult(null);
    try {
      const cases = parseSignatureCases();
      const res = await fetch(`${backendUrl}/api/bench/eval/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ axString: signatureArtifact.axString, cases, metric: signatureMetric }),
      });
      const data = (await res.json()) as SignatureEvalResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSignatureResults(data);
      setStatus(
        data.summary.labeled > 0
          ? `Signature eval: ${data.summary.hits}/${data.summary.labeled} (${(data.summary.accuracy * 100).toFixed(0)}%)`
          : `Signature eval complete: ${data.summary.total} exploratory case(s)`,
      );
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [signatureArtifact, isConnected, parseSignatureCases, backendUrl]);

  const optimizeSignature = useCallback(async () => {
    if (!signatureArtifact) {
      setStatus("Send a signature from Builder first");
      return;
    }
    if (!isConnected) {
      setStatus("Backend unavailable");
      return;
    }
    setIsLoading(true);
    try {
      const cases = parseSignatureCases();
      const res = await fetch(`${backendUrl}/api/bench/eval/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          axString: signatureArtifact.axString,
          cases,
          metric: signatureMetric,
          maxMetricCalls: signatureBudget,
        }),
      });
      const data = (await res.json()) as SignatureOptimizeResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSignatureOptimizeResult(data);
      setStatus(
        `Optimize complete: ${data.before.hits}/${data.before.total} → ${data.after.hits}/${data.after.total}`,
      );
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`);
    }
    setIsLoading(false);
  }, [signatureArtifact, isConnected, parseSignatureCases, backendUrl, signatureBudget]);

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-3">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">Eval &amp; Optimize</span>
        <div className="flex rounded bg-ax-bg border border-ax-border overflow-hidden">
          <button
            onClick={() => setEvalMode("router")}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${evalMode === "router" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <Route className="w-3 h-3" /> Router
          </button>
          <button
            onClick={() => setEvalMode("flow")}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${evalMode === "flow" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <GitBranch className="w-3 h-3" /> Flow
          </button>
          <button
            onClick={() => setEvalMode("signature")}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${evalMode === "signature" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <FlaskConical className="w-3 h-3" /> Signature
          </button>
          <button
            onClick={() => setEvalMode("custom")}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${evalMode === "custom" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <Code2 className="w-3 h-3" /> Custom
          </button>
          <button
            onClick={() => setEvalMode("agent" as any as "router")}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${evalMode === "agent" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <Bot className="w-3 h-3" /> Agent
          </button>
        </div>
        {suite && evalMode === "router" && (
          <button
            onClick={() => setShowCaseList(!showCaseList)}
            className={`flex items-center gap-1 text-xs ${showCaseList ? "text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            <List className="w-3 h-3" />71 cases
          </button>
        )}
        <button
          onClick={() => { setShowExperimentHistory(!showExperimentHistory); if (!showExperimentHistory) fetchExperiments(); }}
          className={`flex items-center gap-1 text-xs ${showExperimentHistory ? "text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
        >
          <History className="w-3 h-3" /> History
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {showExperimentHistory && (
          <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-ax-text-dim uppercase">Experiment History</div>
                <div className="text-sm text-ax-text">{experiments.length} experiment{experiments.length !== 1 ? 's' : ''}</div>
              </div>
              {compareSelection.length === 2 && (
                <div className="text-xs text-ax-text">
                  Comparing: {((compareSelection[0]!.accuracy) * 100).toFixed(0)}% vs {((compareSelection[1]!.accuracy) * 100).toFixed(0)}%
                  {' '}Δ {(compareSelection[1]!.accuracy - compareSelection[0]!.accuracy) > 0 ? '+' : ''}{((compareSelection[1]!.accuracy - compareSelection[0]!.accuracy) * 100).toFixed(1)}pp
                </div>
              )}
            </div>
            <div className="space-y-2">
              {experiments.length === 0 && (
                <div className="text-xs text-ax-text-dim py-4 text-center">No experiments yet. Run a custom or signature eval to create one.</div>
              )}
              {experiments.map(exp => (
                <div key={exp.id} className="rounded border border-ax-border bg-ax-surface p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5 flex-1">
                      <div className="text-xs font-mono text-ax-accent truncate">{exp.ax_string}</div>
                      <div className="flex items-center gap-2 text-[10px] text-ax-text-dim">
                        <span className="uppercase">{exp.target_type}</span>
                        <span>•</span>
                        <span>{exp.run_count} run{exp.run_count !== 1 ? 's' : ''}</span>
                        {exp.latest_run && (
                          <>
                            <span>•</span>
                            <span className={exp.latest_run.accuracy >= 0.8 ? 'text-ax-success' : 'text-ax-warn'}>
                              {exp.latest_run.mode} {(exp.latest_run.accuracy * 100).toFixed(0)}%
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => {
                          const sel = compareSelection.find(s => s.expId === exp.id);
                          if (sel) {
                            setCompareSelection(compareSelection.filter(s => s.expId !== exp.id));
                          } else if (exp.latest_run && compareSelection.length < 2) {
                            setCompareSelection([...compareSelection, { expId: exp.id, runId: exp.latest_run.id, accuracy: exp.latest_run.accuracy, hits: exp.latest_run.hits, total: exp.latest_run.total }]);
                          }
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${compareSelection.some(s => s.expId === exp.id) ? 'bg-ax-primary/20 text-ax-primary' : 'bg-ax-surface-hover text-ax-text-dim hover:text-ax-text'}`}
                      >
                        {compareSelection.some(s => s.expId === exp.id) ? 'Selected' : 'Compare'}
                      </button>
                      <button
                        onClick={() => loadExperiment(exp)}
                        className="text-[10px] px-2 py-0.5 rounded bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => {
                          const name = exp.ax_string.slice(0, 40);
                          const hits = exp.latest_run?.hits ?? 0;
                          const total = exp.latest_run?.total ?? 0;
                          const accuracy = exp.latest_run?.accuracy ?? 0;
                          saveEvalToShelf({ name, axString: exp.ax_string, metric: exp.metric ?? '', accuracy, hits, total });
                        }}
                        className="text-[10px] px-2 py-0.5 rounded bg-ax-surface-hover text-ax-text-dim hover:text-ax-accent transition-colors"
                        title="Save to My Shelf"
                      >
                        Shelf
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {evalMode !== "signature" && (
          <DatasetInventory
            datasets={datasets}
            activeFilter={datasetFilter}
            onFilterChange={setDatasetFilter}
            onLoadDataset={loadDatasetIntoMode}
            onOpenDataset={openDatasetInNotebook}
            onDownloadDataset={downloadDataset}
            onImportDataset={importDataset}
            importStatus={importStatus}
            currentMode={evalMode}
            expanded={datasetsExpanded}
            onToggle={() => setDatasetsExpanded((v) => !v)}
          />
        )}

        {selectedDatasetId && datasetDraftJson && (
          <DatasetDraftEditor
            datasetId={selectedDatasetId}
            draftJson={datasetDraftJson}
            onDraftChange={setDatasetDraftJson}
            saveStatus={datasetSaveStatus}
            onAddCase={addDraftCase}
            onSave={saveDatasetDraft}
            onDeleteCase={deleteDraftCase}
          />
        )}

        {evalMode === "router" && (
          <>
            <RouterControls
              suite={suite}
              isLoading={isLoading}
              selectedCases={selectedCases}
              onSelectCases={setSelectedCases}
              onLoadSuite={loadSuite}
              onRunEval={runRouterEval}
              pushToNotebook={pushToNotebook}
            />
            {status && <div className="text-xs text-ax-text-dim bg-ax-bg rounded px-3 py-2">{status}</div>}
            {suite && showCaseList && (
              <CaseListViewer cases={suite.cases} filter={caseFilter} onFilter={setCaseFilter} pushToNotebook={pushToNotebook} />
            )}
            {summary && <RouterResults summary={summary} pushToNotebook={pushToNotebook} />}
            {suite && isConnected && <OptimizePanel backendUrl={backendUrl} pushToNotebook={pushToNotebook} />}
            {!suite && !summary && <EmptyState connected={isConnected} text="71 routing cases from the test fixtures" />}
          </>
        )}

        {evalMode === "flow" && (
          <>
            <FlowControls
              datasets={datasets}
              selectedFlowId={selectedFlowId}
              onSelectFlow={setSelectedFlowId}
              flowCases={flowCases}
              selectedFlowCases={selectedFlowCases}
              onSelectCases={setSelectedFlowCases}
              isLoading={isLoading}
              onLoadDataset={loadFlowDataset}
              onRunEval={runFlowEval}
            />
            {status && <div className="text-xs text-ax-text-dim bg-ax-bg rounded px-3 py-2">{status}</div>}
            <MetricEditor value={flowMetric} onChange={setFlowMetric} />
            {flowSummary && <AccuracyBar accuracy={flowSummary.accuracy} hits={flowSummary.hits} total={flowSummary.total} />}
            {flowResults && flowResults.length > 0 && (
              <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-2">
                <div className="text-xs text-ax-text-dim uppercase mb-2">Results</div>
                {flowResults.map((result) => (
                  <div key={result.caseId} className={`flex items-center gap-2 text-xs rounded px-2 py-1.5 ${result.score > 0.5 ? "bg-ax-success/10" : "bg-ax-error/10"}`}>
                    {result.score > 0.5 ? <CheckIcon /> : <X className="w-3 h-3 text-ax-error" />}
                    <span className="font-mono text-ax-text-dim/50 w-12">{result.caseId}</span>
                    <span className="text-ax-text-dim">{result.durationMs}ms</span>
                    {result.error && <span className="text-ax-error truncate">{result.error}</span>}
                    {result.finalResponse && (
                      <button
                        onClick={() => pushToNotebook(`// Flow eval result: ${result.caseId} (score=${result.score})\nconst output = ${JSON.stringify(result.output, null, 2)};\noutput;`)}
                        className="ml-auto p-1 text-ax-text-dim hover:text-ax-accent"
                      >
                        <Code2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {datasets.length === 0 && <EmptyState connected={isConnected} text="Load a flow dataset to evaluate pipeline correctness" />}
          </>
        )}

        {evalMode === "signature" && (
          <>
            {status && <div className="text-xs text-ax-text-dim bg-ax-bg rounded px-3 py-2">{status}</div>}
            {!signatureArtifact && (
              <EmptyState connected={isConnected} text="Send a signature from Builder to evaluate and optimize it here" />
            )}
            {signatureArtifact && (
              <>
                <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="text-[10px] text-ax-text-dim uppercase">Target Signature</div>
                      <div className="text-sm font-medium text-ax-text">{signatureArtifact.name}</div>
                      <pre className="text-xs font-mono text-ax-accent bg-ax-surface border border-ax-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                        {signatureArtifact.axString}
                      </pre>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={addSignatureCase}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add case
                      </button>
                      <button
                        onClick={runSignatureEval}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40"
                      >
                        {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        Run
                      </button>
                    </div>
                  </div>
                </div>

                <MetricEditor value={signatureMetric} onChange={setSignatureMetric} />

                <div className="space-y-3">
                  {signatureCases.map((testCase, index) => (
                    <div key={testCase.id} className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-ax-text-dim uppercase">Case {index + 1}</span>
                        <button
                          onClick={() => removeSignatureCase(testCase.id)}
                          className="p-1 text-ax-text-dim hover:text-ax-error transition-colors"
                          title="Remove case"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-1">
                          <span className="text-[10px] text-ax-text-dim uppercase">Input JSON</span>
                          <textarea
                            value={testCase.inputText}
                            onChange={(event) => updateSignatureCase(testCase.id, { inputText: event.target.value })}
                            className="w-full min-h-[132px] bg-ax-surface border border-ax-border rounded-lg p-2 text-xs text-ax-text font-mono resize-y"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] text-ax-text-dim uppercase">Expected JSON (optional)</span>
                          <textarea
                            value={testCase.expectedText}
                            onChange={(event) => updateSignatureCase(testCase.id, { expectedText: event.target.value })}
                            className="w-full min-h-[132px] bg-ax-surface border border-ax-border rounded-lg p-2 text-xs text-ax-text font-mono resize-y"
                            placeholder='{"category":"spam"}'
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-ax-bg border border-ax-primary/20 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-sm font-medium text-ax-text">Optimize Signature</div>
                      <div className="text-xs text-ax-text-dim">
                        Labeled cases only. Validation split comes from the cases you enter here.
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="text-xs text-ax-text-dim">
                        Budget:
                        <select
                          value={signatureBudget}
                          onChange={(event) => setSignatureBudget(Number(event.target.value))}
                          className="ml-1 bg-ax-surface border border-ax-border rounded px-2 py-1 text-xs text-ax-text"
                        >
                          <option value={10}>10 calls</option>
                          <option value={20}>20 calls</option>
                          <option value={40}>40 calls</option>
                        </select>
                      </label>
                      <button
                        onClick={optimizeSignature}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40"
                      >
                        {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                        Optimize
                      </button>
                    </div>
                  </div>

                  {signatureOptimizeResult && (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-ax-border">
                      <div className="space-y-1">
                        <div className="text-[10px] text-ax-text-dim uppercase">Before</div>
                        <div className="text-lg font-mono text-ax-text">
                          {signatureOptimizeResult.before.hits}/{signatureOptimizeResult.before.total}
                        </div>
                        <div className="text-xs text-ax-text-dim">{signatureOptimizeResult.before.pct}%</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[10px] text-ax-text-dim uppercase">After</div>
                        <div className="text-lg font-mono text-ax-accent">
                          {signatureOptimizeResult.after.hits}/{signatureOptimizeResult.after.total}
                        </div>
                        <div className="text-xs text-ax-accent">{signatureOptimizeResult.after.pct}%</div>
                      </div>
                      <div className="col-span-2 text-xs text-ax-success">
                        ▲ +{signatureOptimizeResult.delta} point{signatureOptimizeResult.delta !== 1 ? "s" : ""} improvement
                      </div>
                      <div className="col-span-2 text-[10px] text-ax-text-dim">
                        Train {signatureOptimizeResult.trainCases} · Validation {signatureOptimizeResult.validationCases}
                      </div>
                      <div className="col-span-2 flex gap-2 flex-wrap">
                        <button
                          onClick={() =>
                            pushToNotebook(
                              `// Signature optimize result\nconst optimizeResult = ${JSON.stringify(signatureOptimizeResult, null, 2)};\noptimizeResult;`,
                            )
                          }
                          className="px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                        >
                          Inspect in Notebook
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {signatureResults && (
                  <>
                    <AccuracyBar
                      accuracy={signatureResults.summary.accuracy}
                      hits={signatureResults.summary.hits}
                      total={signatureResults.summary.labeled || signatureResults.summary.total}
                    />
                    <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-2">
                      <div className="text-xs text-ax-text-dim uppercase mb-2">Signature Results</div>
                      {signatureResults.results.map((result, index) => (
                        <div key={`${index}-${result.error ?? "ok"}`} className={`rounded-lg border px-3 py-2 space-y-2 ${result.pass === false || result.error ? "border-ax-error/30 bg-ax-error/5" : result.pass === true ? "border-ax-success/30 bg-ax-success/5" : "border-ax-border bg-ax-surface"}`}>
                          <div className="flex items-center gap-2 text-xs">
                            {result.pass === false || result.error ? <X className="w-3 h-3 text-ax-error" /> : <CheckIcon />}
                            <span className="font-mono text-ax-text-dim/50">case-{index + 1}</span>
                            {typeof result.score === "number" && (
                              <span className="text-ax-text-dim">score {(result.score * 100).toFixed(0)}%</span>
                            )}
                            <button
                              onClick={() =>
                                pushToNotebook(
                                  `// Signature eval result ${index + 1}\nconst result = ${JSON.stringify(result, null, 2)};\nresult;`,
                                )
                              }
                              className="ml-auto p-1 text-ax-text-dim hover:text-ax-accent"
                            >
                              <Code2 className="w-3 h-3" />
                            </button>
                          </div>
                          {result.error ? (
                            <div className="text-xs text-ax-error">{result.error}</div>
                          ) : (
                            <div className="grid gap-2 md:grid-cols-2">
                              <pre className="text-[11px] font-mono text-ax-text-dim bg-ax-surface rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                {formatJson(result.input)}
                              </pre>
                              <pre className="text-[11px] font-mono text-ax-text bg-ax-surface rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                {formatJson(result.output)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {evalMode === "custom" && (
          <>
            {status && <div className="text-xs text-ax-text-dim bg-ax-bg rounded px-3 py-2">{status}</div>}

            {/* Program editor */}
            <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
              <div className="text-[10px] text-ax-text-dim uppercase">Ax Signature Program</div>
              <textarea
                value={customAxString}
                onChange={(e) => setCustomAxString(e.target.value)}
                className="w-full min-h-[60px] bg-ax-surface border border-ax-border rounded-lg p-3 text-sm text-ax-accent font-mono resize-y"
                placeholder='e.g. "question -> short_answer"'
                spellCheck={false}
              />
              {bench.filter(a => a.kind === 'signature').length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-ax-text-dim">Quick-load from shelf:</span>
                  {bench.filter(a => a.kind === 'signature').map(a => (
                    <button
                      key={a.id}
                      onClick={() => quickLoadFromBench(a.id)}
                      className="text-[11px] px-2 py-0.5 rounded bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Dataset picker */}
            <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-ax-text-dim uppercase">Dataset</div>
                {customCases.length > 0 && (
                  <span className="text-xs text-ax-text-dim">{customCases.length} cases</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {datasets.map(d => (
                  <button
                    key={d.id}
                    onClick={() => loadCustomDataset(d.id)}
                    className="text-[11px] px-2 py-1 rounded bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                  >
                    {d.id} ({d.caseCount ?? '?'})
                  </button>
                ))}
              </div>
            </div>

            {/* Metric editor */}
            <MetricEditor value={customMetric} onChange={setCustomMetric} />

            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              {customCases.length > 0 && (
                <>
                  <select value={customSelectedCases} onChange={(e) => setCustomSelectedCases(Number(e.target.value))} className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
                    <option value={5}>5 cases</option>
                    <option value={10}>10 cases</option>
                    <option value={customCases.length}>All ({customCases.length})</option>
                  </select>
                  <button onClick={runCustomEval} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40">
                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run Eval
                  </button>
                </>
              )}
            </div>

            {/* Results */}
            {customSummary && <AccuracyBar accuracy={customSummary.accuracy} hits={customSummary.hits} total={customSummary.total} />}
            {customResults && customResults.length > 0 && (
              <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-2">
                <div className="text-xs text-ax-text-dim uppercase mb-2">Results</div>
                {customResults.map(r => (
                  <div key={r.caseId} className={`flex items-center gap-2 text-xs rounded px-2 py-1.5 ${r.score !== undefined && r.score > 0.5 ? "bg-ax-success/10" : "bg-ax-error/10"}`}>
                    {r.score !== undefined && r.score > 0.5 ? <CheckIcon /> : <X className="w-3 h-3 text-ax-error" />}
                    <span className="font-mono text-ax-text-dim/50 w-12">{r.caseId}</span>
                    <span className="text-ax-text-dim">{r.durationMs}ms</span>
                    {r.error && <span className="text-ax-error truncate">{r.error}</span>}
                    <button
                      onClick={() => pushToNotebook(`// Custom eval result: ${r.caseId} (score=${r.score})\nconst output = ${JSON.stringify(r.output, null, 2)};\noutput;`)}
                      className="ml-auto p-1 text-ax-text-dim hover:text-ax-accent"
                    >
                      <Code2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Optimize */}
            {customCases.filter(c => isPlainObject(c.expected)).length >= 2 && (
              <div className="bg-ax-bg border border-ax-primary/20 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-medium text-ax-text">Optimize</div>
                    <div className="text-xs text-ax-text-dim">GEPA-tune with labeled cases</div>
                  </div>
                  <button
                    onClick={runCustomOptimize}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40"
                  >
                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                    Optimize
                  </button>
                </div>
                {customOptimizeResult && (
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-ax-border">
                    <div className="space-y-1">
                      <div className="text-[10px] text-ax-text-dim uppercase">Before</div>
                      <div className="text-lg font-mono text-ax-text">{customOptimizeResult.before.hits}/{customOptimizeResult.before.total}</div>
                      <div className="text-xs text-ax-text-dim">{customOptimizeResult.before.pct}%</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[10px] text-ax-text-dim uppercase">After</div>
                      <div className="text-lg font-mono text-ax-accent">{customOptimizeResult.after.hits}/{customOptimizeResult.after.total}</div>
                      <div className="text-xs text-ax-accent">{customOptimizeResult.after.pct}%</div>
                    </div>
                    <div className="col-span-2 text-xs text-ax-success">
                      ▲ +{customOptimizeResult.delta} point{customOptimizeResult.delta !== 1 ? "s" : ""} improvement
                    </div>
                    <div className="col-span-2">
                      <button
                        onClick={() => pushToNotebook(`// Custom optimize result\nconst result = ${JSON.stringify(customOptimizeResult, null, 2)};\nresult;`)}
                        className="px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                      >
                        Inspect in Notebook
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Agent eval mode (Phase 3) */}
        {evalMode === "agent" && (
          <>
            {status && <div className="text-xs text-ax-text-dim bg-ax-bg rounded px-3 py-2">{status}</div>}

            {/* Agent selector */}
            <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[10px] text-ax-text-dim uppercase">Target Agent</span>
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  className="bg-ax-surface border border-ax-border rounded px-2 py-1 text-xs text-ax-text"
                >
                  {['seeker', 'scribe', 'sorter', 'architect', 'librarian', 'conductor', 'connector', 'scout', 'clarify'].map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Test cases */}
            <div className="space-y-3">
              {agentCases.map((tc, i) => (
                <div key={tc.id} className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-ax-text-dim uppercase">Case {i + 1}</span>
                    <button
                      onClick={() => removeAgentCase(tc.id)}
                      className="p-1 text-ax-text-dim hover:text-ax-error transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[10px] text-ax-text-dim uppercase">User Prompt</span>
                      <textarea
                        value={tc.prompt}
                        onChange={(e) => updateAgentCase(tc.id, { prompt: e.target.value })}
                        className="w-full min-h-[80px] bg-ax-surface border border-ax-border rounded-lg p-2 text-xs text-ax-text font-mono resize-y"
                        placeholder="What is the capital of France?"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] text-ax-text-dim uppercase">Expected Response (contains)</span>
                      <textarea
                        value={tc.expected ?? ''}
                        onChange={(e) => updateAgentCase(tc.id, { expected: e.target.value || undefined })}
                        className="w-full min-h-[80px] bg-ax-surface border border-ax-border rounded-lg p-2 text-xs text-ax-text font-mono resize-y"
                        placeholder="Paris"
                      />
                    </label>
                  </div>
                </div>
              ))}
              <button
                onClick={addAgentCase}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add case
              </button>

              {/* Phase 7: Load dataset into agent mode */}
              {datasets.filter(d => d.type === 'flow').length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-ax-text-dim">Load from dataset:</span>
                  {datasets.filter(d => d.type === 'flow').map(d => (
                    <button
                      key={d.id}
                      onClick={async () => {
                        try {
                          const res = await fetch(`${backendUrl}/api/datasets/${d.id}`);
                          const data = await res.json();
                          const cases = (data.cases ?? []) as Array<{ id?: string; input?: unknown; expected?: unknown; prompt?: string }>;
                          const agentCases = cases.map((c, i) => ({
                            id: c.id ?? `load-${d.id}-${i}`,
                            prompt: typeof c.input === 'string' ? c.input : c.prompt ?? JSON.stringify(c.input ?? {}),
                            expected: typeof c.expected === 'string' ? c.expected : undefined,
                          }));
                          setAgentCases(agentCases.length > 0 ? agentCases : [{ id: 'empty-case', prompt: '' }]);
                          setStatus(`Loaded ${agentCases.length} cases from ${d.id}`);
                        } catch (e) {
                          setStatus(`Load failed: ${e instanceof Error ? e.message : 'Unknown'}`);
                        }
                      }}
                      className="text-[11px] px-2 py-1 rounded bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                    >
                      {d.id} ({d.caseCount ?? '?'})
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Metric */}
            <MetricEditor value={agentMetric} onChange={setAgentMetric} />

            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <select value={agentSelectedCases} onChange={(e) => setAgentSelectedCases(Number(e.target.value))} className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
                <option value={5}>5 cases</option>
                <option value={10}>10 cases</option>
                <option value={agentCases.length}>All ({agentCases.length})</option>
              </select>
              <button onClick={runAgentEval} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40">
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run Agent Eval
              </button>
            </div>

            {/* Summary */}
            {agentSummary && <AccuracyBar accuracy={agentSummary.accuracy} hits={agentSummary.hits} total={agentSummary.labeled} />}

            {/* Results */}
            {agentResults && agentResults.length > 0 && (
              <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-2">
                <div className="text-xs text-ax-text-dim uppercase mb-2">Results</div>
                {agentResults.map(r => (
                  <div key={r.caseId} className={`flex items-center gap-2 text-xs rounded px-2 py-1.5 ${r.score !== undefined && r.score > 0.5 ? "bg-ax-success/10" : "bg-ax-error/10"}`}>
                    {r.score !== undefined && r.score > 0.5 ? <CheckIcon /> : <X className="w-3 h-3 text-ax-error" />}
                    <span className="font-mono text-ax-text-dim/50 w-16">{r.caseId}</span>
                    <span className="text-ax-text-dim">{r.durationMs}ms</span>
                    {r.error && <span className="text-ax-error truncate">{r.error}</span>}
                    {r.output !== undefined && (
                      <>
                        <button
                          onClick={() => pushToNotebook(`// Agent eval result: ${r.caseId}\nconst response = ${JSON.stringify(r.output, null, 2)};\nresponse;`)}
                          className="ml-auto p-1 text-ax-text-dim hover:text-ax-accent"
                        >
                          <Code2 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => pushEvalTrace({
                            label: `Agent eval: ${r.caseId}`,
                            routeAgent: agentId,
                            mechanism: `eval: score=${r.score ?? 'N/A'}`,
                          })}
                          className="p-1 text-ax-text-dim hover:text-ax-primary"
                          title="Replay trace"
                        >
                          <Clock className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

function CheckIcon() { return <div className="w-3 h-3 rounded-full bg-ax-success flex items-center justify-center"><span className="text-[7px] text-black">✓</span></div>; }

function EmptyState({ connected, text }: { connected: boolean; text: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-ax-text-dim">
      <div className="text-center">
        <Target className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">{text}</p>
        <p className="text-xs mt-1">{connected ? "Connect to crew to get started" : "Demo mode — use canned results"}</p>
      </div>
    </div>
  );
}

function DatasetDraftEditor({
  datasetId,
  draftJson,
  onDraftChange,
  saveStatus,
  onAddCase,
  onSave,
  onDeleteCase,
}: {
  datasetId: string;
  draftJson: string;
  onDraftChange: (value: string) => void;
  saveStatus: string;
  onAddCase: () => void;
  onSave: () => void;
  onDeleteCase: (caseId: string) => void | Promise<void>;
}) {
  let caseIds: string[] = [];
  try {
    const parsed = JSON.parse(draftJson) as { cases?: Array<{ id?: string }> };
    caseIds = Array.isArray(parsed.cases)
      ? parsed.cases.map((testCase) => String(testCase.id ?? "")).filter(Boolean)
      : [];
  } catch {
    caseIds = [];
  }

  return (
    <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-ax-text-dim uppercase">Dataset editor</div>
          <div className="text-sm text-ax-text">{datasetId}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={onAddCase}
            className="px-2.5 py-1 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
          >
            Add case
          </button>
          <button
            onClick={onSave}
            className="px-2.5 py-1 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors"
          >
            Save dataset
          </button>
        </div>
      </div>

      {caseIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {caseIds.map((caseId) => (
            <button
              key={caseId}
              onClick={() => onDeleteCase(caseId)}
              className="text-[10px] px-2 py-0.5 rounded-full bg-ax-error/10 text-ax-error hover:bg-ax-error/20 transition-colors"
              title={`Delete ${caseId}`}
            >
              Delete {caseId}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={draftJson}
        onChange={(e) => onDraftChange(e.target.value)}
        className="w-full min-h-[280px] bg-ax-surface border border-ax-border rounded-lg p-3 text-xs text-ax-text font-mono resize-y"
        spellCheck={false}
      />

      {saveStatus && <div className="text-xs text-ax-text-dim">{saveStatus}</div>}
    </div>
  );
}

function DatasetInventory({
  datasets,
  activeFilter,
  onFilterChange,
  onLoadDataset,
  onOpenDataset,
  onDownloadDataset,
  onImportDataset,
  importStatus,
  currentMode,
  expanded,
  onToggle,
}: {
  datasets: FlowDataset[];
  activeFilter: DatasetKindFilter;
  onFilterChange: (filter: DatasetKindFilter) => void;
  onLoadDataset: (dataset: FlowDataset) => void | Promise<void>;
  onOpenDataset: (datasetId: string) => void | Promise<void>;
  onDownloadDataset: (datasetId: string) => void | Promise<void>;
  onImportDataset: (jsonText: string) => void | Promise<void>;
  importStatus: string;
  currentMode: "router" | "flow" | "signature" | "custom" | "agent";
  expanded: boolean;
  onToggle: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const totalCount = datasets.length;
  const routerCount = datasets.filter((dataset) => dataset.type === "router").length;
  const flowCount = datasets.filter((dataset) => dataset.type === "flow").length;

  const filteredDatasets = datasets.filter((dataset) => {
    if (activeFilter === "all") return true;
    return dataset.type === activeFilter;
  });

  return (
    <div className="bg-ax-bg border border-ax-border rounded-lg p-4 space-y-3">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full text-left"
      >
        <div>
          <div className="text-xs text-ax-text-dim uppercase">Datasets</div>
          <div className="text-sm text-ax-text">
            {filteredDatasets.length} dataset{filteredDatasets.length !== 1 ? "s" : ""}
          </div>
        </div>
        <span className="text-ax-text-dim text-xs transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
      </button>

      {expanded && (
        <>
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => onFilterChange("all")}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${activeFilter === "all" ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-surface-hover text-ax-text-dim hover:text-ax-text"}`}
            >
              All ({totalCount})
            </button>
            <button
              onClick={() => onFilterChange("router")}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${activeFilter === "router" ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-surface-hover text-ax-text-dim hover:text-ax-text"}`}
            >
              Router ({routerCount})
            </button>
            <button
              onClick={() => onFilterChange("flow")}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${activeFilter === "flow" ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-surface-hover text-ax-text-dim hover:text-ax-text"}`}
            >
              Flows ({flowCount})
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === 'string') {
                    onImportDataset(reader.result);
                  }
                };
                reader.readAsText(file);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors"
            >
              Import dataset
            </button>
            {importStatus && <span className="text-[10px] text-ax-text-dim">{importStatus}</span>}
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredDatasets.map((dataset) => {
              const isCurrentMode = dataset.type === currentMode;
              return (
                <div key={dataset.id} className="rounded-lg border border-ax-border bg-ax-surface p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-ax-text truncate">{dataset.id}</div>
                      <div className="text-[11px] text-ax-text-dim truncate">{dataset.file}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${dataset.type === "router" ? "bg-ax-warn/15 text-ax-warn" : "bg-ax-success/15 text-ax-success"}`}>
                      {dataset.type}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-ax-text-dim flex-wrap">
                    <span>{dataset.caseCount ?? 0} case{dataset.caseCount === 1 ? "" : "s"}</span>
                    <span className="text-ax-text-dim/40">•</span>
                    <span>{dataset.targetId ?? "router"}</span>
                    {isCurrentMode && (
                      <>
                        <span className="text-ax-text-dim/40">•</span>
                        <span className="text-ax-primary">current mode</span>
                      </>
                    )}
                  </div>

                  {dataset.description && (
                    <p className="text-xs text-ax-text-dim">{dataset.description}</p>
                  )}

                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => onLoadDataset(dataset)}
                      className="px-2.5 py-1 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => onOpenDataset(dataset.id)}
                      className="px-2.5 py-1 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                    >
                      Open JSON
                    </button>
                    <button
                      onClick={() => onDownloadDataset(dataset.id)}
                      className="px-2.5 py-1 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
                    >
                      Download
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function RouterControls({ suite, isLoading, selectedCases, onSelectCases, onLoadSuite, onRunEval, pushToNotebook }: any) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button onClick={onLoadSuite} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors disabled:opacity-40">
        <FlaskConical className="w-3.5 h-3.5" /> Load Suite
      </button>
      {suite && (
        <>
          <select value={selectedCases} onChange={(e) => onSelectCases(Number(e.target.value))} className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
            <option value={10}>10 cases</option><option value={25}>25 cases</option><option value={50}>50 cases</option><option value={suite.cases.length}>All ({suite.cases.length})</option>
          </select>
          <button onClick={onRunEval} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40">
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run Eval
          </button>
        </>
      )}
    </div>
  );
}

function CaseListViewer({ cases, filter, onFilter, pushToNotebook }: { cases: EvalCase[]; filter: string | null; onFilter: (a: string | null) => void; pushToNotebook: (c: string) => void }) {
  const filtered = filter ? cases.filter(c => c.expectedAgent === filter) : cases;
  const agents = Array.from(new Map(cases.map(c => [c.expectedAgent, c.expectedAgent])).entries());
  return (
    <div className="bg-ax-bg border border-ax-border rounded-lg p-4">
      <div className="text-xs text-ax-text-dim uppercase mb-3 flex items-center justify-between">
        <span>Cases ({filtered.length})</span><span className="text-ax-text-dim/50">Click a case to open in notebook</span>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        <button onClick={() => onFilter(null)} className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${filter === null ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-surface-hover text-ax-text-dim hover:text-ax-text"}`}>All ({cases.length})</button>
        {agents.map(([a]) => { const count = cases.filter(c => c.expectedAgent === a).length; return (
          <button key={a} onClick={() => onFilter(a)} className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${filter === a ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-surface-hover text-ax-text-dim hover:text-ax-text"}`}>{a} ({count})</button>
        );})}
      </div>
      <div className="space-y-1 max-h-96 overflow-y-auto">
        {filtered.slice(0, 100).map(c => (
          <div key={c.id} className="flex items-center gap-2 text-xs text-ax-text bg-ax-surface rounded px-2 py-1.5 group">
            <span className="text-ax-text-dim/50 font-mono w-10 shrink-0">{c.id}</span>
            <span className={`font-mono w-16 shrink-0 ${c.expectedAgent === "clarify" ? "text-ax-warn" : "text-ax-accent"}`}>{c.expectedAgent}</span>
            <span className="text-ax-text-dim truncate flex-1">{c.request}</span>
            <button onClick={() => pushToNotebook(`// Eval case ${c.id}: expect "${c.expectedAgent}"\nconst req = ${JSON.stringify(c.request)};\nconst res = await fetch("/api/eval/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cases: [{ id: "${c.id}", expectedAgent: "${c.expectedAgent}", request: req }] }) });\nconst data = await res.json();\ndata;`)} className="opacity-0 group-hover:opacity-100 p-1 rounded text-ax-text-dim hover:text-ax-primary transition-all"><ExternalLink className="w-3 h-3" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RouterResults({ summary, pushToNotebook }: { summary: EvalSummary; pushToNotebook: (c: string) => void }) {
  return (
    <div className="space-y-3">
      <AccuracyBar accuracy={summary.accuracy} hits={summary.hits} total={summary.total} />
      <div className="bg-ax-bg border border-ax-border rounded-lg p-4">
        <div className="text-xs text-ax-text-dim uppercase mb-3">Per Agent</div>
        <div className="space-y-1.5">
          {Object.entries(summary.byLabel).sort(([, a], [, b]) => b.hit / b.n - a.hit / a.n).map(([label, { hit, n }]) => {
            const pct = n > 0 ? (hit / n) * 100 : 0;
            return <div key={label} className="flex items-center gap-2">
              <span className="text-xs font-mono text-ax-text w-24 text-right truncate">{label}</span>
              <div className="flex-1 h-1.5 bg-ax-surface rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${pct === 100 ? "bg-ax-success" : pct >= 75 ? "bg-ax-accent" : pct >= 50 ? "bg-ax-warn" : "bg-ax-error"}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[10px] font-mono text-ax-text-dim w-16 text-right">{hit}/{n}</span>
            </div>;
          })}
        </div>
      </div>
      {summary.misses.length > 0 && (
        <div className="bg-ax-bg border border-ax-border rounded-lg p-4">
          <div className="text-xs text-ax-text-dim uppercase mb-3 flex items-center gap-1.5"><X className="w-3 h-3 text-ax-error" /> Misses ({summary.misses.length})</div>
          {summary.misses.map(m => (
            <div key={m.id} className="text-xs text-ax-text-dim bg-ax-surface rounded px-2 py-1.5 group flex items-start gap-2">
              <div className="flex-1">
                <span className="text-ax-text-dim/50">{m.id}</span> <span className="text-ax-warn">expected</span> <span className="font-mono text-ax-warn">{m.expected}</span> <span className="text-ax-error">→</span> <span className="font-mono text-ax-error">{m.got}</span>
                <div className="text-ax-text-dim/60 mt-0.5">&ldquo;{m.request}&rdquo;</div>
              </div>
              <button onClick={() => pushToNotebook(`// Eval miss: expected "${m.expected}" but got "${m.got}"\nconst r = await ax("query -> agent_id").forward(llm, { query: ${JSON.stringify(m.request)} });\nr;`)} className="opacity-0 group-hover:opacity-100 p-1 rounded text-ax-text-dim hover:text-ax-primary transition-all shrink-0"><ExternalLink className="w-3 h-3" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlowControls({ datasets, selectedFlowId, onSelectFlow, flowCases, selectedFlowCases, onSelectCases, isLoading, onLoadDataset, onRunEval }: any) {
  const flowDatasets = datasets.filter((d: FlowDataset) => d.type === "flow");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] text-ax-text-dim uppercase">Target Flow</span>
        <select value={selectedFlowId} onChange={(e) => onSelectFlow(e.target.value)} className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
          {["braindump-triage", "deep-clean", "defrag", "prior-art", "project-scaffold", "tag-garden", "triage-route", "vault-assess", "vault-audit"].map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        {flowDatasets.length > 0 && (
          <button onClick={() => onLoadDataset(`${selectedFlowId}-cases`)} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors disabled:opacity-40">
            <BookOpen className="w-3.5 h-3.5" /> Load Dataset
          </button>
        )}
      </div>
      {flowCases.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <select value={selectedFlowCases} onChange={(e) => onSelectCases(Number(e.target.value))} className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
            <option value={5}>5 cases</option><option value={10}>10 cases</option><option value={flowCases.length}>All ({flowCases.length})</option>
          </select>
          <button onClick={onRunEval} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40">
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run Flow Eval
          </button>
        </div>
      )}
    </div>
  );
}

function OptimizePanel({ backendUrl, pushToNotebook }: { backendUrl: string; pushToNotebook: (c: string) => void }) {
  const [budget, setBudget] = useState(20);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [status, setStatus] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [result, setResult] = useState<{ before: { hits: number; total: number; pct: string }; after: { hits: number; total: number; pct: string }; delta: number } | null>(null);

  const startOptimize = useCallback(async () => {
    setIsOptimizing(true); setStatus("Setting up..."); setResult(null);
    try {
      const res = await fetch(`${backendUrl}/api/eval/optimize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxMetricCalls: budget }) });
      const reader = res.body?.getReader(); if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) continue;
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.stage === "baseline") setStatus(`Baseline: ${event.beforeHits}/${event.holdoutTotal} (${event.beforePct}%)`);
            else if (event.stage === "optimizing") setStatus(`Optimizing... (max ${event.maxMetricCalls} metric calls)`);
            else if (event.stage === "setup") setStatus(`Split: ${event.train} train / ${event.holdout} holdout`);
            if (event.before && event.after) { setResult(event); setStatus("Done"); }
            if (event.error) setStatus(`Error: ${event.error}`);
          } catch { /* skip */ }
        }
      }
    } catch (e) { setStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`); }
    setIsOptimizing(false);
  }, [backendUrl, budget]);

  return (
    <div className="bg-ax-bg border border-ax-primary/20 rounded-lg p-4 space-y-3">
      <span className="text-sm font-medium text-ax-text">GEPA Optimize</span>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-ax-text-dim">Budget:
          <select value={budget} onChange={e => setBudget(Number(e.target.value))} className="ml-1 bg-ax-surface border border-ax-border rounded px-2 py-1 text-xs text-ax-text">
            <option value={10}>10 calls</option><option value={20}>20 calls</option><option value={40}>40 calls</option>
          </select>
        </label>
        <button onClick={startOptimize} disabled={isOptimizing} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors disabled:opacity-40">
          {isOptimizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run GEPA Optimize
        </button>
      </div>
      {status && <div className="text-xs text-ax-text-dim">{status}</div>}
      {result && (
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-ax-border">
          <div className="space-y-1"><div className="text-[10px] text-ax-text-dim uppercase">Before</div><div className="text-lg font-mono text-ax-text">{result.before.hits}/{result.before.total}</div><div className="text-xs text-ax-text-dim">{result.before.pct}%</div></div>
          <div className="space-y-1"><div className="text-[10px] text-ax-text-dim uppercase">After</div><div className="text-lg font-mono text-ax-accent">{result.after.hits}/{result.after.total}</div><div className="text-xs text-ax-accent">{result.after.pct}%</div></div>
          <div className="col-span-2 text-xs text-ax-success">▲ +{result.delta} point{result.delta !== 1 ? "s" : ""} improvement</div>
          <div className="col-span-2 flex gap-2 pt-1 flex-wrap">
            <button onClick={async () => { setSaveStatus("Saving..."); try { const r = await fetch(`${backendUrl}/api/eval/optimize/save`, { method: "POST" }); const d = await r.json(); setSaveStatus(d.message ?? (d.error ? `Error: ${d.error}` : "Saved")); } catch (e) { setSaveStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`); }}} className="px-3 py-1.5 rounded text-xs bg-ax-success text-white hover:bg-ax-success/80 transition-colors">Save Optimized</button>
            <button onClick={async () => { setSaveStatus("Reverting..."); try { const r = await fetch(`${backendUrl}/api/eval/optimize/restore`, { method: "POST" }); const d = await r.json(); setSaveStatus(d.message ?? "Reverted"); } catch (e) { setSaveStatus(`Error: ${e instanceof Error ? e.message : "Failed"}`); }}} className="px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors">Revert</button>
            <button onClick={() => pushToNotebook(`// GEPA Optimize result\nconst result = ${JSON.stringify(result, null, 2)};\nresult;`)} className="px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors">Inspect in Notebook</button>
          </div>
          {saveStatus && <div className="col-span-2 text-[10px] text-ax-text-dim">{saveStatus}</div>}
        </div>
      )}
    </div>
  );
}
