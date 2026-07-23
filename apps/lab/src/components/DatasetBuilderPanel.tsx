"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Plus,
  Check,
  X,
  Edit3,
  ArrowUpDown,
  Database,
  Inbox,
  Filter,
  Layers,
  Search,
  History,
  MessageSquare,
  Sparkles,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  AlertTriangle,
  BarChart3,
  ExternalLink,
  Brain,
} from "lucide-react";
import { useLabStore, type Candidate, type RunSummary } from "@/lib/store";
import type { DatasetSummary, DatasetCoverage } from "@/lib/store";

// ── helpers ──────────────────────────────────────────────────────────

const makeId = () =>
  `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function formatSourceLabel(cand: Candidate): string {
  switch (cand.source) {
    case "manual":
      return "you";
    case "run":
      return "run";
    case "slack":
      return "Slack";
    case "variation":
      return "variation";
    case "gap":
      return "gap fill";
    case "proposed":
      return "proposed";
    default:
      return cand.source;
  }
}

type SourceTab = "author" | "runs" | "slack" | "propose";

// ── Run Search (sub-component) ────────────────────────────────────

function RunSearchPanel({
  runs,
  onSendToTray,
  onRefresh,
}: {
  runs: RunSummary[];
  onSendToTray: (ids: string[]) => void;
  onRefresh: () => void;
}) {
  const { backendUrl, fetchRuns } = useLabStore();
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [routeFilter, setRouteFilter] = useState("");
  const [sort, setSort] = useState("started_at_desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const availableRoutes = Array.from(
    new Set(runs.map((r) => r.selected_route_id).filter(Boolean) as string[])
  ).sort();

  const doSearch = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (searchQ.trim()) params.set("q", searchQ.trim());
    if (statusFilter) params.set("status", statusFilter);
    if (routeFilter) params.set("route", routeFilter);
    if (sort === "confidence_asc") params.set("sort", "confidence_asc");

    try {
      const res = await fetch(`${backendUrl}/api/runs?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      useLabStore.setState({ runs: (data as { runs: RunSummary[] }).runs ?? [] });
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [backendUrl, searchQ, statusFilter, routeFilter, sort]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const all = new Set(runs.map((r) => r.id));
    setSelected(all);
  };

  const clearSelection = () => setSelected(new Set());

  const handleSendSelected = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    onSendToTray(ids);
    setSelected(new Set());
  };

  const formatConfidence = (v: number | null) => {
    if (v === null) return "";
    return `${(v * 100).toFixed(0)}%`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="p-2 space-y-1.5 border-b border-ax-border shrink-0">
        <div className="flex gap-1">
          <div className="flex-1 flex items-center gap-1 bg-ax-bg border border-ax-border rounded px-2">
            <Search className="w-3 h-3 text-ax-text-dim" />
            <input
              className="flex-1 bg-transparent text-xs text-ax-text py-1 outline-none"
              placeholder="Search requests…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
            />
          </div>
          <button
            onClick={doSearch}
            disabled={loading}
            className="px-2 py-1 rounded text-[10px] bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 transition-colors disabled:opacity-40"
          >
            {loading ? "…" : "Search"}
          </button>
        </div>

        <div className="flex gap-1 text-[10px]">
          <select
            className="bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">all status</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
          <select
            className="bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text"
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
          >
            <option value="">all routes</option>
            {availableRoutes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            className="bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="started_at_desc">latest first</option>
            <option value="confidence_asc">low confidence first</option>
          </select>
        </div>
      </div>

      {/* Action bar */}
      <div className="h-7 border-b border-ax-border flex items-center px-2 gap-2 shrink-0 text-[10px]">
        <button onClick={selectAll} className="text-ax-text-dim hover:text-ax-text">
          select all
        </button>
        <button onClick={clearSelection} className="text-ax-text-dim hover:text-ax-text">
          clear
        </button>
        <span className="text-ax-text-dim/40">
          {runs.length} runs · {selected.size} selected
        </span>
        <button
          onClick={handleSendSelected}
          disabled={selected.size === 0}
          className="ml-auto px-2 py-0.5 rounded bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 disabled:opacity-30 transition-colors"
        >
          Send {selected.size > 0 ? selected.size : ""} to tray
        </button>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {runs.length === 0 && (
          <div className="flex items-center justify-center h-full text-ax-text-dim">
            <div className="text-center p-4">
              <History className="w-6 h-6 mx-auto mb-1 opacity-30" />
              <p className="text-xs">No runs match.</p>
              <p className="text-[10px] text-ax-text-dim/50 mt-0.5">
                Try different filters or search terms.
              </p>
            </div>
          </div>
        )}

        {runs.map((run) => {
          const isSelected = selected.has(run.id);
          const isCompleted = run.status === "completed";
          const isFailed = run.status === "failed";

          return (
            <div
              key={run.id}
              onClick={() => toggleSelect(run.id)}
              className={`border-b border-ax-border/40 px-2 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${
                isSelected ? "bg-ax-primary/10" : "hover:bg-ax-surface-hover"
              } ${isFailed ? "bg-ax-error/5" : ""}`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSelect(run.id)}
                className="shrink-0 w-3 h-3"
              />
              {/* Status icon */}
              <span className="shrink-0">
                {isCompleted ? (
                  <CheckCircle className="w-3 h-3 text-ax-success" />
                ) : isFailed ? (
                  <XCircle className="w-3 h-3 text-ax-error" />
                ) : (
                  <Clock className="w-3 h-3 text-ax-warn" />
                )}
              </span>
              {/* Preview */}
              <div className="min-w-0 flex-1">
                <div className="text-ax-text truncate max-w-[350px]">
                  {run.request_preview}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {run.selected_route_id && (
                    <span className="text-[10px] font-mono text-ax-accent bg-ax-accent/10 px-1 rounded">
                      {run.selected_route_id}
                    </span>
                  )}
                  {run.route_confidence !== null && (
                    <span
                      className={`text-[10px] px-1 rounded ${
                        (run.route_confidence ?? 0) < 0.5
                          ? "bg-ax-warn/15 text-ax-warn"
                          : "bg-ax-surface-hover text-ax-text-dim"
                      }`}
                    >
                      {formatConfidence(run.route_confidence)}
                    </span>
                  )}
                  {run.durationMs !== null && (
                    <span className="text-[10px] text-ax-text-dim/50">
                      {run.durationMs < 1000
                        ? `${run.durationMs}ms`
                        : `${(run.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Slack Source (sub-component) ─────────────────────────────────

function SlackSourcePanel({ onLoad }: { onLoad: () => Promise<Candidate[] | undefined> }) {
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  const handleLoad = async () => {
    setLoading(true);
    const result = await onLoad();
    setLoading(false);
    if (result) setCount(result.length);
    else setCount(0);
  };

  return (
    <div className="flex flex-col h-full items-center justify-center text-ax-text-dim p-6">
      <MessageSquare className="w-10 h-10 mb-3 opacity-30" />
      <p className="text-xs text-center mb-2">
        Load un-reviewed Slack eval pairs as candidates.
      </p>
      <p className="text-[10px] text-ax-text-dim/50 text-center mb-4">
        Routing overrides and corrections from real Slack usage.
        Each pair becomes a candidate in the tray for you to review.
      </p>
      <button
        onClick={handleLoad}
        disabled={loading}
        className="px-3 py-1.5 rounded text-xs bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 disabled:opacity-40 transition-colors"
      >
        {loading ? "Loading…" : "Load Slack candidates"}
      </button>
      {count !== null && (
        <p className="text-[10px] text-ax-text-dim mt-2">
          {count > 0 ? `Loaded ${count} candidates` : "No unreviewed pairs found"}
        </p>
      )}
    </div>
  );
}

// ── Propose Source (sub-component) ────────────────────────────

function ProposeSourcePanel({
  onLoad,
}: {
  onLoad: (opts?: { target?: string; lookback?: number }) => Promise<Candidate[] | undefined>;
}) {
  const { availableModels } = useLabStore();
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [target, setTarget] = useState("incident-agent");
  const [lookback, setLookback] = useState(25);

  const agentIds = availableModels.filter((m) => m !== "crew");

  const handleLoad = async () => {
    setLoading(true);
    const result = await onLoad({ target, lookback });
    setLoading(false);
    if (result) setCount(result.length);
    else setCount(0);
  };

  return (
    <div className="flex flex-col h-full items-center justify-center text-ax-text-dim p-6">
      <Brain className="w-10 h-10 mb-3 opacity-30" />
      <p className="text-xs text-center mb-2">
        Analyze recent run traces and propose eval cases.
      </p>
      <p className="text-[10px] text-ax-text-dim/50 text-center mb-4">
        The Eval Proposer agent reads the last N runs for an agent, finds gaps
        and regressions, and proposes test cases for the human to approve.
      </p>

      {/* Target agent selector */}
      <div className="flex items-center gap-2 mb-2 text-[10px]">
        <span className="text-ax-text-dim">Target:</span>
        <select
          className="bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {agentIds.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {/* Lookback control */}
      <div className="flex items-center gap-2 mb-4 text-[10px]">
        <span className="text-ax-text-dim">Last</span>
        <input
          type="number"
          min={5}
          max={200}
          value={lookback}
          onChange={(e) => setLookback(Math.min(200, Math.max(5, Number(e.target.value) || 25)))}
          className="w-14 bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text text-center"
        />
        <span className="text-ax-text-dim">runs</span>
      </div>

      <button
        onClick={handleLoad}
        disabled={loading}
        className="px-3 py-1.5 rounded text-xs bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 disabled:opacity-40 transition-colors"
      >
        {loading ? "Proposing…" : "Propose from traces"}
      </button>

      {count !== null && (
        <p className="text-[10px] text-ax-text-dim mt-2">
          {count > 0
            ? `Proposed ${count} candidates`
            : "Nothing new found — dataset is current"}
        </p>
      )}
    </div>
  );
}

// ── Dataset Viewer (sub-component) ───────────────────────────────

function DatasetViewerPanel() {
  const {
    datasetList,
    selectedDatasetId,
    datasetCases,
    datasetCoverage,
    fetchDatasets,
    setSelectedDatasetId,
    fetchDatasetCases,
    fetchDatasetCoverage,
    deleteDatasetCase,
    fillGap,
    candidates,
    addCandidates,
  } = useLabStore();

  const [filter, setFilter] = useState<"all" | "router" | "flow">("all");

  useEffect(() => {
    fetchDatasets();
  }, [fetchDatasets]);

  useEffect(() => {
    if (selectedDatasetId) {
      fetchDatasetCases(selectedDatasetId);
      fetchDatasetCoverage(selectedDatasetId);
    }
  }, [selectedDatasetId, fetchDatasetCases, fetchDatasetCoverage]);

  const filtered = datasetList.filter((d) =>
    filter === "all" ? true : d.type === filter
  );

  const formatPreview = (c: Record<string, unknown>) => {
    const req = typeof c.request === 'string' ? c.request : null;
    const inp = typeof c.input === 'string' ? c.input : (typeof c.input === 'object' && c.input !== null ? JSON.stringify(c.input) : null);
    return ((req ?? inp ?? "").slice(0, 80));
  };

  const formatExpected = (c: Record<string, unknown>, type: 'router' | 'flow') => {
    if (type === 'router') return (c.expectedAgent as string) ?? "?";
    if (typeof c.expected === 'object') return JSON.stringify(c.expected).slice(0, 40);
    return String(c.expected ?? "").slice(0, 40);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Dataset list */}
      <div className="border-b border-ax-border shrink-0">
        <div className="h-8 flex items-center px-2 gap-1 text-[10px] border-b border-ax-border/40">
          <button
            onClick={() => setFilter("all")}
            className={`px-1.5 py-0.5 rounded ${filter === "all" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            All ({datasetList.length})
          </button>
          <button
            onClick={() => setFilter("router")}
            className={`px-1.5 py-0.5 rounded ${filter === "router" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            Router
          </button>
          <button
            onClick={() => setFilter("flow")}
            className={`px-1.5 py-0.5 rounded ${filter === "flow" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
          >
            Flows
          </button>
        </div>

        <div className="max-h-48 overflow-y-auto">
          {filtered.map((ds) => {
            const isSelected = ds.id === selectedDatasetId;
            return (
              <div
                key={ds.id}
                onClick={() => setSelectedDatasetId(isSelected ? null : ds.id)}
                className={`px-2 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors border-b border-ax-border/20 ${
                  isSelected ? "bg-ax-primary/10" : "hover:bg-ax-surface-hover"
                }`}
              >
                <span className="text-[10px] px-1 rounded bg-ax-surface-hover text-ax-text-dim shrink-0">
                  {ds.type}
                </span>
                <span className="text-ax-text truncate flex-1">{ds.id}</span>
                <span className="text-[10px] text-ax-text-dim/50 shrink-0">
                  {ds.caseCount}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cases viewer */}
      {selectedDatasetId ? (
        <>
          {/* Coverage bar */}
          {datasetCoverage && (
            <div className="border-b border-ax-border p-2 shrink-0 space-y-1.5">
              <div className="flex items-center gap-1 text-[10px] text-ax-text-dim">
                <BarChart3 className="w-3 h-3" />
                <span>{datasetCoverage.total} cases</span>
                {datasetCoverage.regressionCount > 0 && (
                  <span className="text-ax-error">
                    · {datasetCoverage.regressionCount} regression
                  </span>
                )}
              </div>

              {/* Per-route bars */}
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {Object.entries(datasetCoverage.byRoute)
                  .sort(([, a], [, b]) => b - a)
                  .map(([agent, count]) => {
                    const max = Math.max(...Object.values(datasetCoverage.byRoute));
                    const pct = max > 0 ? (count / max) * 100 : 0;
                    const isThin = datasetCoverage.thin.includes(agent);
                    return (
                      <div key={agent} className="flex items-center gap-1">
                        <span
                          className={`text-[9px] w-16 truncate text-right shrink-0 ${isThin ? "text-ax-warn" : "text-ax-text-dim"}`}
                        >
                          {agent}
                        </span>
                        <div className="flex-1 h-2 bg-ax-surface rounded overflow-hidden">
                          <div
                            className={`h-full rounded transition-all ${isThin ? "bg-ax-warn/40" : "bg-ax-primary/30"}`}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                        <span
                          className={`text-[9px] w-6 shrink-0 ${isThin ? "text-ax-warn font-medium" : "text-ax-text-dim/50"}`}
                        >
                          {count}
                        </span>
                        {isThin && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              fillGap(selectedDatasetId, agent);
                            }}
                            className="text-[9px] px-1 py-0.5 rounded bg-ax-warn/10 text-ax-warn hover:bg-ax-warn/20"
                          >
                            Fill
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>

              {/* Thin routes callout */}
              {datasetCoverage.thin.length > 0 && (
                <div className="flex items-center gap-1 text-[9px] text-ax-warn">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  Thin: {datasetCoverage.thin.join(", ")}
                </div>
              )}
            </div>
          )}

          {/* Header */}
          <div className="h-7 border-b border-ax-border flex items-center px-2 shrink-0 text-[10px] text-ax-text-dim gap-2">
            <span className="uppercase">{selectedDatasetId}</span>
            <span className="text-ax-text-dim/40">{datasetCases.length} cases</span>
          </div>

          {/* Cases table */}
          <div className="flex-1 overflow-y-auto">
            {datasetCases.length === 0 && (
              <div className="flex items-center justify-center h-full text-ax-text-dim/30">
                <p className="text-[10px]">No cases</p>
              </div>
            )}
            {datasetCases.map((c) => {
              const dsType =
                datasetList.find((d) => d.id === selectedDatasetId)?.type ??
                "router";
              return (
                <div
                  key={c.id as string}
                  className="border-b border-ax-border/30 px-2 py-1.5 text-[10px] flex items-start gap-1.5 group hover:bg-ax-surface-hover transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-ax-text truncate">
                      {formatPreview(c)}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                      <span className="text-ax-accent/70 font-mono">
                        → {formatExpected(c, dsType)}
                      </span>
                      {(c.regression as boolean) === true && (
                        <span className="text-[9px] px-1 rounded bg-ax-error/10 text-ax-error">
                          regression
                        </span>
                      )}
                      {(c.sourceRunId ? (
                        <span className="text-ax-text-dim/30">
                          {(c.sourceRunId as string).slice(0, 8)}
                        </span>
                      ) : null)}
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      deleteDatasetCase(selectedDatasetId, c.id as string)
                    }
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-ax-text-dim/30 hover:text-ax-error transition-all shrink-0"
                    title="Delete case"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-ax-text-dim/30">
          <div className="text-center p-4">
            <Database className="w-6 h-6 mx-auto mb-1 opacity-30" />
            <p className="text-[10px]">Select a dataset</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────

export function DatasetBuilderPanel() {
  const {
    backendUrl,
    availableModels,
    fetchModels,
    candidates,
    runs,
    builderDatasetId,
    builderDatasetType,
    setBuilderDatasetId,
    setBuilderDatasetType,
    addCandidates,
    addManualCandidate,
    updateCandidate,
    acceptCandidate,
    rejectCandidate,
    acceptAllPending,
    clearCandidates,
    fetchRuns,
    loadSlackCandidates,
    loadProposedCandidates,
    generateVariations,
    sendRunsToTray,
  } = useLabStore();

  const [focusedIdx, setFocusedIdx] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab>("author");
  const [variationN, setVariationN] = useState(3);

  // Author form state
  const [authorRequest, setAuthorRequest] = useState("");
  const [authorExpectedAgent, setAuthorExpectedAgent] = useState("");
  const [authorFlowInput, setAuthorFlowInput] = useState("");
  const [authorFlowExpected, setAuthorFlowExpected] = useState("{}");
  const [authorDatasetId, setAuthorDatasetId] = useState("routing-cases");
  const [authorDatasetType, setAuthorDatasetType] = useState<"router" | "flow">("router");

  const listRef = useRef<HTMLDivElement>(null);

  // Fetch models + runs on mount
  useEffect(() => {
    fetchModels();
    fetchRuns();
  }, [fetchModels, fetchRuns]);

  const agentIds = availableModels.filter((m) => m !== "crew");
  const pending = candidates.filter((c) => c.status === "pending");
  const accepted = candidates.filter((c) => c.status === "accepted").length;
  const rejected = candidates.filter((c) => c.status === "rejected").length;

  // Sync focusedIdx to bounds
  useEffect(() => {
    if (pending.length === 0) setFocusedIdx(0);
    else if (focusedIdx >= pending.length) setFocusedIdx(pending.length - 1);
  }, [pending.length, focusedIdx]);

  // Scroll focused row into view
  useEffect(() => {
    if (!listRef.current || pending.length === 0) return;
    const row = listRef.current.querySelector(`[data-cand-id="${pending[focusedIdx]?.candidateId}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedIdx, pending]);

  // ── keyboard handlers ──────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (pending.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIdx((i) => (i + 1) % pending.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIdx((i) => (i - 1 + pending.length) % pending.length);
      } else if (e.key === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cand = pending[focusedIdx];
        if (cand) acceptCandidate(cand.candidateId);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cand = pending[focusedIdx];
        if (cand) rejectCandidate(cand.candidateId);
      } else if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cand = pending[focusedIdx];
        if (cand) setEditingId(cand.candidateId);
      } else if (e.key === "Enter" && editingId) {
        e.preventDefault();
        setEditingId(null);
      } else if (e.key === "Escape") {
        setEditingId(null);
      }
    },
    [pending, focusedIdx, acceptCandidate, rejectCandidate, editingId],
  );

  // ── author handlers ────────────────────────────────────────────

  const handleAuthorRouter = () => {
    if (!authorRequest.trim() || !authorExpectedAgent) return;
    const datasetId = authorDatasetId || "routing-cases";
    addManualCandidate({
      caseFields: {
        id: makeId(),
        request: authorRequest.trim(),
        expectedAgent: authorExpectedAgent,
        regression: false,
      },
      datasetId,
      datasetType: "router",
    });
    setAuthorRequest("");
    setAuthorExpectedAgent("");
  };

  const handleAuthorFlow = () => {
    if (!authorFlowInput.trim()) return;
    let expected: unknown = {};
    try {
      expected = JSON.parse(authorFlowExpected);
    } catch {
      expected = authorFlowExpected;
    }
    const datasetId = authorDatasetId || "routing-cases";
    addManualCandidate({
      caseFields: {
        id: makeId(),
        input: authorFlowInput.trim(),
        expected,
        metric: "function score(output, expected) { return 0; }",
        regression: false,
      },
      datasetId,
      datasetType: "flow",
    });
    setAuthorFlowInput("");
    setAuthorFlowExpected("{}");
  };

  const handleAcceptAll = async () => {
    setBatchStatus("Saving…");
    const result = await acceptAllPending();
    if (result.errors.length > 0) {
      setBatchStatus(`Saved ${result.saved}; ${result.errors.length} errors`);
    } else {
      setBatchStatus(`Saved ${result.saved} cases`);
    }
    setTimeout(() => setBatchStatus(null), 3000);
  };

  // ── variations handler ─────────────────────────────────────────

  const handleVariations = (candidateId: string) => {
    const cand = candidates.find((c) => c.candidateId === candidateId);
    if (!cand) return;
    generateVariations(cand.case.id as string, variationN);
  };

  // ── render candidate row ───────────────────────────────────────

  const renderRow = (cand: Candidate, idx: number) => {
    const focused = pending.indexOf(cand) === focusedIdx;
    const isEditing = editingId === cand.candidateId;
    const requestStr = typeof cand.case.request === 'string' ? cand.case.request : null;
    const inputStr = typeof cand.case.input === 'string' ? cand.case.input : (typeof cand.case.input === 'object' && cand.case.input !== null ? JSON.stringify(cand.case.input) : null);
    const preview = (requestStr ?? inputStr)?.slice(0, 100) ?? "(no preview)";
    const expected =
      cand.datasetType === "router"
        ? (cand.case.expectedAgent as string) ?? "?"
        : typeof cand.case.expected === "object"
          ? JSON.stringify(cand.case.expected).slice(0, 60)
          : String(cand.case.expected ?? "").slice(0, 60);

    return (
      <div
        key={cand.candidateId}
        data-cand-id={cand.candidateId}
        className={`border-b border-ax-border/40 px-3 py-2 text-xs flex items-start gap-2 transition-colors ${
          focused ? "bg-ax-primary/10 ring-1 ring-inset ring-ax-primary/30" : ""
        }`}
        onClick={() => setFocusedIdx(idx)}
      >
        {/* source badge */}
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-ax-surface-hover text-ax-text-dim mt-0.5">
          {formatSourceLabel(cand)}
        </span>

        <div className="min-w-0 flex-1">
          {/* preview + target */}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-ax-text truncate max-w-[300px]">{preview}</span>
            <span className="text-[10px] text-ax-text-dim/50 shrink-0">
              → {expected}
            </span>
          </div>
          <div className="text-[10px] text-ax-text-dim/40 mt-0.5">
            {cand.datasetId}
          </div>

          {/* inline edit */}
          {isEditing && (
            <div className="mt-1 space-y-1">
              <textarea
                className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text font-mono"
                rows={3}
                defaultValue={
                  cand.datasetType === "router"
                    ? (cand.case.request as string) ?? ""
                    : (cand.case.input as string) ?? ""
                }
                onChange={(ev) => {
                  const key = cand.datasetType === "router" ? "request" : "input";
                  updateCandidate(cand.candidateId, {
                    case: { ...cand.case, [key]: ev.target.value },
                  });
                }}
              />
              {cand.datasetType === "router" && (
                <select
                  className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text"
                  defaultValue={cand.case.expectedAgent as string}
                  onChange={(ev) => {
                    updateCandidate(cand.candidateId, {
                      case: { ...cand.case, expectedAgent: ev.target.value },
                    });
                  }}
                >
                  <option value="">-- expected agent --</option>
                  {agentIds.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              )}
              {cand.datasetType === "flow" && (
                <textarea
                  className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text font-mono"
                  rows={2}
                  defaultValue={
                    typeof cand.case.expected === "object"
                      ? JSON.stringify(cand.case.expected, null, 2)
                      : String(cand.case.expected ?? "")
                  }
                  onChange={(ev) => {
                    updateCandidate(cand.candidateId, {
                      case: { ...cand.case, expected: ev.target.value },
                    });
                  }}
                />
              )}
              <div className="text-[10px] text-ax-text-dim">
                Enter to finish editing, Esc to cancel
              </div>
            </div>
          )}

          {/* Variations button */}
          {cand.status === "pending" && (cand.source === "manual" || cand.source === "run") && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleVariations(cand.candidateId);
              }}
              className="mt-1 px-1.5 py-0.5 rounded text-[10px] bg-ax-accent/10 text-ax-accent hover:bg-ax-accent/20 transition-colors flex items-center gap-1"
            >
              <Sparkles className="w-2.5 h-2.5" />×{variationN} variations
            </button>
          )}
        </div>

        {/* action buttons */}
        <div className="flex items-center gap-0.5 shrink-0 text-[10px]">
          <span className="text-ax-text-dim/40 w-6 text-center">
            {focused ? "a r e" : ""}
          </span>
        </div>
      </div>
    );
  };

  // ── render ─────────────────────────────────────────────────────

  return (
    <div
      className="h-full flex bg-ax-bg overflow-hidden"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Left: Author/Sources + Tray */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-ax-border">
        {/* Header */}
        <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-2">
          <Database className="w-3.5 h-3.5 text-ax-accent" />
          <span className="text-xs text-ax-text-dim uppercase tracking-wider">
            Dataset Builder
          </span>

          {/* source tabs */}
          <div className="flex rounded overflow-hidden border border-ax-border text-[10px] ml-3">
            {([
              { id: "author" as const, label: "Author" },
              { id: "runs" as const, label: "Runs" },
              { id: "slack" as const, label: "Slack" },
              { id: "propose" as const, label: "Propose" },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSourceTab(tab.id)}
                className={`px-2 py-0.5 transition-colors ${
                  sourceTab === tab.id
                    ? "bg-ax-primary/20 text-ax-primary"
                    : "text-ax-text-dim hover:text-ax-text"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {candidates.length > 0 && (
              <button
                onClick={clearCandidates}
                className="px-2 py-0.5 rounded text-[10px] text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover transition-colors"
              >
                Clear tray
              </button>
            )}
          </div>
        </div>

        {/* Source panel (switches by tab) */}
        {sourceTab === "author" && (
          <div className="border-b border-ax-border p-3 shrink-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-ax-text-dim uppercase">Author a case</span>

              <div className="flex rounded overflow-hidden border border-ax-border text-[10px]">
                <button
                  onClick={() => {
                    setAuthorDatasetType("router");
                    setAuthorDatasetId("routing-cases");
                  }}
                  className={`px-2 py-0.5 transition-colors ${
                    authorDatasetType === "router"
                      ? "bg-ax-primary/20 text-ax-primary"
                      : "text-ax-text-dim hover:text-ax-text"
                  }`}
                >
                  router
                </button>
                <button
                  onClick={() => {
                    setAuthorDatasetType("flow");
                    setAuthorDatasetId("");
                  }}
                  className={`px-2 py-0.5 transition-colors ${
                    authorDatasetType === "flow"
                      ? "bg-ax-primary/20 text-ax-primary"
                      : "text-ax-text-dim hover:text-ax-text"
                  }`}
                >
                  flow
                </button>
              </div>

              <input
                className="flex-1 bg-ax-bg border border-ax-border rounded px-2 py-0.5 text-[10px] text-ax-text"
                placeholder="dataset id (e.g. routing-cases)"
                value={authorDatasetId}
                onChange={(e) => setAuthorDatasetId(e.target.value)}
              />
            </div>

            {authorDatasetType === "router" ? (
              <div className="flex gap-2">
                <textarea
                  className="flex-1 bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text resize-none"
                  rows={2}
                  placeholder="User request text…"
                  value={authorRequest}
                  onChange={(e) => setAuthorRequest(e.target.value)}
                />
                <div className="flex flex-col gap-1 shrink-0 w-40">
                  <select
                    className="bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text"
                    value={authorExpectedAgent}
                    onChange={(e) => setAuthorExpectedAgent(e.target.value)}
                  >
                    <option value="">-- expected agent --</option>
                    {agentIds.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleAuthorRouter}
                    disabled={!authorRequest.trim() || !authorExpectedAgent}
                    className="px-2 py-1 rounded text-[10px] bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 disabled:opacity-30 transition-colors flex items-center gap-1 justify-center"
                  >
                    <Plus className="w-3 h-3" /> Add to tray
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text font-mono resize-none"
                  rows={2}
                  placeholder='Flow input (e.g. {"input": "text"})'
                  value={authorFlowInput}
                  onChange={(e) => setAuthorFlowInput(e.target.value)}
                />
                <div className="flex gap-2">
                  <textarea
                    className="flex-1 bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text font-mono resize-none"
                    rows={2}
                    placeholder="Expected output (JSON)"
                    value={authorFlowExpected}
                    onChange={(e) => setAuthorFlowExpected(e.target.value)}
                  />
                  <button
                    onClick={handleAuthorFlow}
                    disabled={!authorFlowInput.trim()}
                    className="px-2 py-1 rounded text-[10px] bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 disabled:opacity-30 transition-colors flex items-center gap-1 justify-center shrink-0"
                  >
                    <Plus className="w-3 h-3" /> Add to tray
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {sourceTab === "runs" && (
          <div className="flex-1 min-h-0 border-b border-ax-border">
            <RunSearchPanel
              runs={runs}
              onSendToTray={(ids) => sendRunsToTray(ids)}
              onRefresh={() => fetchRuns()}
            />
          </div>
        )}

        {sourceTab === "slack" && (
          <div className="flex-1 min-h-0 border-b border-ax-border">
            <SlackSourcePanel onLoad={loadSlackCandidates} />
          </div>
        )}

        {sourceTab === "propose" && (
          <ProposeSourcePanel onLoad={loadProposedCandidates} />
        )}

        {/* Variations count control */}
        <div className="h-7 border-b border-ax-border flex items-center px-3 shrink-0 text-[10px] text-ax-text-dim gap-2">
          <Sparkles className="w-3 h-3 text-ax-accent" />
          <span>Variations per seed:</span>
          <input
            type="number"
            min={1}
            max={10}
            value={variationN}
            onChange={(e) => setVariationN(Math.min(10, Math.max(1, Number(e.target.value) || 3)))}
            className="w-12 bg-ax-bg border border-ax-border rounded px-1.5 py-0.5 text-ax-text text-center"
          />
        </div>

        {/* Tray content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="h-8 border-b border-ax-border flex items-center px-3 text-[10px] text-ax-text-dim gap-3 shrink-0">
            <Inbox className="w-3 h-3" />
            <span>Tray</span>
            <span className="text-ax-text-dim/50">
              {pending.length} pending
              {accepted > 0 && ` · ${accepted} accepted`}
              {rejected > 0 && ` · ${rejected} rejected`}
            </span>

            <div className="ml-auto flex items-center gap-1">
              {pending.length > 0 && (
                <button
                  onClick={handleAcceptAll}
                  className="px-2 py-0.5 rounded bg-ax-success/15 text-ax-success hover:bg-ax-success/25 transition-colors"
                >
                  Accept all pending
                </button>
              )}
              {batchStatus && (
                <span className="text-ax-text-dim/60">{batchStatus}</span>
              )}
            </div>
          </div>

          {/* Scrollable candidate list */}
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {pending.length === 0 && (
              <div className="flex items-center justify-center h-full text-ax-text-dim">
                <div className="text-center p-6">
                  <Layers className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">No candidates in the tray.</p>
                  <p className="text-[10px] text-ax-text-dim/50 mt-1">
                    Author a case or load candidates from Runs / Slack.
                  </p>
                  <div className="mt-3 flex items-center justify-center gap-3 text-[10px] text-ax-text-dim/40">
                    <span>
                      <kbd className="px-1 py-0.5 bg-ax-surface rounded text-ax-text-dim/60">a</kbd> accept
                    </span>
                    <span>
                      <kbd className="px-1 py-0.5 bg-ax-surface rounded text-ax-text-dim/60">r</kbd> reject
                    </span>
                    <span>
                      <kbd className="px-1 py-0.5 bg-ax-surface rounded text-ax-text-dim/60">e</kbd> edit
                    </span>
                  </div>
                </div>
              </div>
            )}

            {pending.map((cand, idx) => renderRow(cand, idx))}
          </div>
        </div>
      </div>

      {/* Right: Dataset viewer */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0">
          <span className="text-xs text-ax-text-dim uppercase tracking-wider">
            Datasets
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <DatasetViewerPanel />
        </div>
      </div>
    </div>
  );
}
