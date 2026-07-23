"use client";

import { useEffect, useState, useCallback } from "react";
import {
  X,
  GitBranch,
  Loader2,
  Play,
  FlaskConical,
  FileText,
  ExternalLink,
  BarChart3,
} from "lucide-react";
import { useLabStore } from "@/lib/store";

interface FlowDetailProps {
  flowId: string;
  flow: {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    approvalRequired: boolean;
    isAxFlow?: boolean;
    sourceFile?: string;
  };
  onClose: () => void;
  onRunEval?: (flowId: string) => void;
}

interface ExperimentEntry {
  id: string;
  target_type: string;
  target_id: string | null;
  ax_string: string;
  metric: string | null;
  created_at: string;
  latest_run: {
    id: string;
    mode: string;
    accuracy: number;
    hits: number;
    total: number;
    created_at: string;
  } | null;
  run_count: number;
}

export function FlowDetailOverlay({ flowId, flow, onClose, onRunEval }: FlowDetailProps) {
  const { backendUrl, navigateToSource, pushToNotebook } = useLabStore();
  const [experiments, setExperiments] = useState<ExperimentEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchExperiments = useCallback(async () => {
    try {
      const res = await fetch(
        `${backendUrl}/api/eval/experiments?targetType=flow&targetId=${encodeURIComponent(flowId)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setExperiments((data.experiments ?? []) as ExperimentEntry[]);
    } catch {
      // non-critical
    }
    setLoading(false);
  }, [backendUrl, flowId]);

  useEffect(() => {
    setLoading(true);
    fetchExperiments();
  }, [fetchExperiments]);

  const latestEval = experiments[0];

  return (
    <div className="absolute inset-0 z-50 bg-ax-bg/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-ax-surface border border-ax-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="h-12 border-b border-ax-border flex items-center px-4 shrink-0 gap-3">
          <GitBranch className="w-4 h-4 text-ax-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ax-text truncate">{flow.name}</div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Badges */}
          <div className="flex gap-2 flex-wrap">
            {flow.isAxFlow && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-primary/20 text-ax-primary font-mono">
                flow()
              </span>
            )}
            {flow.approvalRequired && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-warn/20 text-ax-warn">
                needs approval
              </span>
            )}
          </div>

          {/* Description */}
          <p className="text-sm text-ax-text">{flow.description}</p>

          {/* Triggers */}
          {flow.triggers.length > 0 && (
            <div>
              <div className="text-[10px] text-ax-text-dim uppercase mb-1">Triggers</div>
              <div className="flex flex-wrap gap-1">
                {flow.triggers.map((t) => (
                  <span
                    key={t}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim"
                  >
                    "{t}"
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Source file */}
          {flow.sourceFile && (
            <button
              onClick={() => {
                navigateToSource(flow.sourceFile!, 1);
                onClose();
              }}
              className="flex items-center gap-2 text-xs text-ax-text-dim hover:text-ax-primary transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              <span className="font-mono">{flow.sourceFile}</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {flow.isAxFlow && (
              <button
                onClick={() => {
                  pushToNotebook(
                    `// Run the "${flow.name}" flow directly\n// Triggers: ${flow.triggers.slice(0, 3).join(', ')}\n\nconst response = await fetch("http://127.0.0.1:8788/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({\n    model: "crew",\n    messages: [{ role: "user", content: "${flow.triggers[0] || 'YOUR_REQUEST'}"}],\n    stream: false,\n  }),\n});\nconst data = await response.json();\ndata;`,
                  );
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-surface-hover text-ax-text hover:bg-ax-border transition-colors"
              >
                <Play className="w-3 h-3" />
                Notebook
              </button>
            )}
            {onRunEval && (
              <button
                onClick={() => {
                  onRunEval(flowId);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary-dim transition-colors"
              >
                <FlaskConical className="w-3 h-3" />
                Quick Eval
              </button>
            )}
          </div>

          {/* Eval History */}
          <div className="border-t border-ax-border pt-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-3.5 h-3.5 text-ax-accent" />
              <span className="text-xs text-ax-text-dim uppercase">Eval History</span>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 text-ax-primary animate-spin" />
              </div>
            )}

            {!loading && experiments.length === 0 && (
              <div className="text-xs text-ax-text-dim py-4 text-center border border-dashed border-ax-border rounded-lg">
                No evals yet. Run a flow eval to see results here.
              </div>
            )}

            {!loading &&
              experiments.map((exp) => (
                <div
                  key={exp.id}
                  className="border border-ax-border rounded-lg p-3 mb-2 space-y-2 bg-ax-bg/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-ax-accent truncate max-w-[60%]">
                      {exp.ax_string}
                    </span>
                    <span className="text-[10px] text-ax-text-dim">
                      {exp.run_count} run{exp.run_count !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {exp.latest_run && (
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="h-1.5 bg-ax-bg rounded-full overflow-hidden">
                          <div
                            className="h-full bg-ax-success rounded-full transition-all"
                            style={{ width: `${exp.latest_run.accuracy * 100}%` }}
                          />
                        </div>
                      </div>
                      <span
                        className={`text-xs font-mono ${
                          exp.latest_run.accuracy >= 0.8 ? "text-ax-success" : "text-ax-warn"
                        }`}
                      >
                        {(exp.latest_run.accuracy * 100).toFixed(0)}%
                      </span>
                      <span className="text-[10px] text-ax-text-dim">
                        {exp.latest_run.mode}
                      </span>
                    </div>
                  )}
                </div>
              ))}

            {latestEval && (
              <div className="text-center pt-1">
                <button
                  onClick={() => {
                    pushToNotebook(
                      `// Eval history for flow "${flow.name}"\n// ${experiments.length} experiment(s), most recent: ${latestEval.latest_run ? `${(latestEval.latest_run.accuracy * 100).toFixed(0)}% accuracy` : 'not yet run'}\n\nconst experiments = ${JSON.stringify(experiments.slice(0, 5), null, 2)};\nexperiments;`,
                    );
                    onClose();
                  }}
                  className="text-[10px] text-ax-text-dim hover:text-ax-accent transition-colors"
                >
                  Open in Notebook →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
