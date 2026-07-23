"use client";

import { useEffect, useState } from "react";
import { Clock, X, CheckCircle, XCircle, ExternalLink } from "lucide-react";
import { useLabStore, type RunSummary } from "@/lib/store";

export function RunsHistoryPanel() {
  const {
    runs,
    showRunHistory,
    setShowRunHistory,
    fetchRuns,
    loadRunTrace,
    activeSessionId,
    isConnected,
    selectedRunTrace,
  } = useLabStore();

  useEffect(() => {
    if (showRunHistory && isConnected) {
      // If we have an active session, scope runs to that session
      fetchRuns(activeSessionId ?? undefined);
    }
  }, [showRunHistory, isConnected, fetchRuns, activeSessionId]);

  if (!showRunHistory) return null;

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "";
    }
  };

  const formatDuration = (ms: number | null) => {
    if (ms === null) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const handleInspect = async (runId: string) => {
    await loadRunTrace(runId);
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30" onClick={() => setShowRunHistory(false)} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-40 w-96 bg-ax-surface border-l border-ax-border flex flex-col shadow-xl">
        {/* Header */}
        <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0">
          <span className="text-xs text-ax-text-dim uppercase tracking-wider">
            Run History
          </span>
          {activeSessionId && (
            <span className="text-[10px] text-ax-text-dim/50 ml-2">
              (this session)
            </span>
          )}
          <button
            onClick={() => setShowRunHistory(false)}
            className="p-0.5 ml-auto rounded text-ax-text-dim hover:text-ax-text transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 && (
            <div className="flex items-center justify-center h-full text-ax-text-dim">
              <div className="text-center p-6">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">
                  {isConnected
                    ? "No runs yet"
                    : "Connect to crew to see history"}
                </p>
              </div>
            </div>
          )}

          {runs.map((run) => (
            <RunRow key={run.id} run={run} onInspect={handleInspect} />
          ))}
        </div>

        {/* Footer with currently selected trace info */}
        {selectedRunTrace && (
          <div className="border-t border-ax-border p-3">
            <div className="text-[10px] text-ax-text-dim uppercase mb-1">
              Inspecting Run
            </div>
            <div className="text-xs text-ax-text">
              Route:{" "}
              <span className="font-mono text-ax-accent">
                {selectedRunTrace.routeDecision?.agent ?? "none"}
              </span>
            </div>
            <p className="text-[10px] text-ax-text-dim/50 mt-1">
              Trace loaded into the Live Trace panel
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function RunRow({
  run,
  onInspect,
}: {
  run: RunSummary;
  onInspect: (runId: string) => void;
}) {
  const isSuccess = run.status === "completed";
  const isFailed = run.status === "failed";
  const { backendUrl, setActivePanel, setEvalMode } = useLabStore();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleSaveDataset = async (kind: "baseline" | "regression") => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const res = await fetch(`${backendUrl}/api/runs/${run.id}/save-as-dataset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json() as {
        saved?: boolean;
        error?: string;
        datasetId?: string;
        datasetType?: "router" | "flow";
        caseCount?: number;
      };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed: ${res.status}`);
      }

      const actionLabel = kind === "regression" ? "Regression saved" : "Saved";
      setSaveStatus(`${actionLabel} → ${data.datasetId} (${data.caseCount ?? 0} cases)`);
      setEvalMode(data.datasetType === "flow" ? "flow" : "router");
      setActivePanel("eval");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className={`border-b border-ax-border/50 px-3 py-2.5 transition-colors hover:bg-ax-surface-hover ${
        isFailed ? "bg-ax-error/5" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <div className="mt-0.5 shrink-0">
          {isSuccess ? (
            <CheckCircle className="w-3.5 h-3.5 text-ax-success" />
          ) : isFailed ? (
            <XCircle className="w-3.5 h-3.5 text-ax-error" />
          ) : (
            <Clock className="w-3.5 h-3.5 text-ax-warn animate-pulse" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Request preview */}
          <div className="text-xs text-ax-text truncate">
            {run.request_preview || run.original_request.slice(0, 120)}
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {/* Route */}
            {run.selected_route_id && (
              <span className="text-[10px] font-mono text-ax-accent bg-ax-accent/10 px-1 py-0.5 rounded">
                {run.selected_route_id}
              </span>
            )}

            {/* Duration */}
            {run.durationMs !== null && (
              <span className="text-[10px] text-ax-text-dim/50">
                {run.durationMs < 1000
                  ? `${run.durationMs}ms`
                  : `${(run.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}

            {/* Time */}
            <span className="text-[10px] text-ax-text-dim/50">
              {new Date(run.started_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>

          {/* Error preview */}
          {isFailed && (
            <div className="text-[10px] text-ax-error/70 mt-0.5 truncate">
              Failed
            </div>
          )}

          {saveStatus && (
            <div className="text-[10px] text-ax-text-dim mt-1 truncate">
              {saveStatus}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isSuccess && run.selected_route_id && (
            <button
              onClick={() => handleSaveDataset("baseline")}
              disabled={isSaving}
              className="px-2 py-1 rounded text-[10px] bg-ax-primary/15 text-ax-primary hover:bg-ax-primary/25 transition-colors disabled:opacity-40"
              title="Save this successful run as an eval case"
            >
              {isSaving ? "Saving…" : "Save eval"}
            </button>
          )}
          {isFailed && run.selected_route_id && (
            <button
              onClick={() => handleSaveDataset("regression")}
              disabled={isSaving}
              className="px-2 py-1 rounded text-[10px] bg-ax-error/15 text-ax-error hover:bg-ax-error/25 transition-colors disabled:opacity-40"
              title="Save this failed run as a regression case"
            >
              {isSaving ? "Saving…" : "Save regression"}
            </button>
          )}
          <button
            onClick={() => onInspect(run.id)}
            className="p-1 rounded hover:bg-ax-primary/10 text-ax-text-dim hover:text-ax-primary transition-colors"
            title="Inspect trace"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
