"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { Clock, Wrench, Lightbulb, ExternalLink, Loader2, ArrowRight, BarChart3, Cpu } from "lucide-react";
import { useLabStore } from "@/lib/store";
import { DEMO_TRACE, DEMO_MERMAID } from "@/lib/demo";
import { MermaidDiagram } from "./MermaidDiagram";

/** Build Mermaid sequence diagram from trace events */
function buildMermaid(
  routeDecision: { agent: string; mechanism: string } | null,
  toolCalls: Array<{ name: string; args: Record<string, unknown>; source?: { tuningTips?: string[] } }>,
): string {
  if (!routeDecision && toolCalls.length === 0) return "";

  // Sanitize a name for use as a Mermaid participant id (letters, digits, underscores only)
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

  const lines = ["sequenceDiagram", "    participant U as You", "    participant R as Router"];
  const participants = new Set<string>();
  let lastAgent = "";

  if (routeDecision) {
    const agentId = sanitize(routeDecision.agent);
    participants.add(agentId);
    lastAgent = routeDecision.agent;
    lines.push(`    participant ${agentId} as ${routeDecision.agent}`);
    lines.push(`    U->>R: query`);
    lines.push(`    R->>${agentId}: route (${routeDecision.mechanism.slice(0, 30)})`);
  }

  for (const tc of toolCalls) {
    const shortName = tc.name.startsWith("vault.") ? tc.name.slice(6) : tc.name;
    const tcId = sanitize(shortName);
    if (!participants.has(tcId)) {
      participants.add(tcId);
      lines.push(`    participant ${tcId} as ${shortName}`);
    }
    const argsPreview = JSON.stringify(tc.args).slice(0, 40).replace(/"/g, "");
    const caller = lastAgent ? sanitize(lastAgent) : "R";
    lines.push(`    ${caller}->>${tcId}: ${shortName}(${argsPreview}${JSON.stringify(tc.args).length > 40 ? "..." : ""})`);
    lines.push(`    ${tcId}-->>${caller}: result`);
  }

  if (lastAgent) {
    lines.push(`    ${sanitize(lastAgent)}-->>U: answer`);
  }

  return lines.join("\n");
}

function ToolCallCard({
  call,
}: {
  call: ReturnType<typeof useLabStore.getState>["currentTrace"]["toolCalls"][0];
}) {
  const [expanded, setExpanded] = useState(false);
  const navigateToSource = useLabStore((s) => s.navigateToSource);

  return (
    <div className="border border-ax-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ax-surface-hover transition-colors"
      >
        <Wrench className="w-3 h-3 text-ax-tool shrink-0" />
        <span className="text-xs font-mono text-ax-tool">{call.name}</span>
        <span className="text-[10px] text-ax-text-dim ml-auto">
          {call.durationMs}ms
        </span>
      </button>

      {expanded && (
        <div className="border-t border-ax-border px-3 py-2 space-y-2 bg-ax-bg/50">
          {/* Args */}
          <div>
            <div className="text-[10px] text-ax-text-dim uppercase mb-1">
              Arguments
            </div>
            <pre className="text-xs text-ax-text bg-ax-bg rounded p-1.5 overflow-x-auto">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {call.result !== undefined && (
            <div>
              <div className="text-[10px] text-ax-text-dim uppercase mb-1">
                Result
              </div>
              <pre className="text-xs text-ax-text bg-ax-bg rounded p-1.5 overflow-x-auto max-h-32">
                {typeof call.result === "string"
                  ? call.result
                  : JSON.stringify(call.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Source + Tuning Tips */}
          {call.source && (
            <div className="space-y-1.5">
              <button
                onClick={() => navigateToSource(call.source!.file, call.source!.line)}
                className="flex items-center gap-2 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                <span className="font-mono">
                  {call.source.file}:{call.source.line}
                </span>
                <span className="text-ax-primary">
                  {call.source.function}()
                </span>
              </button>

              {call.source.tuningTips && call.source.tuningTips.length > 0 && (
                <div className="space-y-1">
                  {call.source.tuningTips.map((tip, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-1.5 text-[10px]"
                    >
                      <Lightbulb className="w-3 h-3 text-ax-warn shrink-0 mt-0.5" />
                      <span className="text-ax-text-dim">{tip}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LangfuseObs {
  id: string;
  name: string;
  type: string;
  startTime: string;
  endTime?: string;
  model?: string;
  input?: string;
  output?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  level?: string;
  statusMessage?: string;
}

function LangfuseTraceCard({
  langfuseUrl,
  backendUrl,
  live,
}: {
  langfuseUrl: string;
  backendUrl: string;
  live: boolean;
}) {
  const [obs, setObs] = useState<LangfuseObs[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const traceId = langfuseUrl.split("/trace/")[1]?.split(/[?#]/)[0];
    if (!traceId) {
      setObs([]);
      setError("Bad trace URL");
      setLoading(false);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(
          `${backendUrl}/api/langfuse/trace/${encodeURIComponent(traceId)}?ts=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (live && res.status === 404) {
            setError(null);
            setLoading(true);
            timer = setTimeout(poll, 1000);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (cancelled) return;

        setObs(Array.isArray(data.observations) ? data.observations : []);
        setError(null);
        setLoading(false);
        setLastUpdated(Date.now());

        if (live) {
          timer = setTimeout(poll, 1000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
        if (live) {
          timer = setTimeout(poll, 1500);
        }
      }
    };

    setLoading(true);
    setError(null);
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [langfuseUrl, backendUrl, live]);

  const generations = obs.filter((o) => o.type === "GENERATION");
  const spans = obs.filter((o) => o.type === "SPAN");
  const totalTokens = obs.reduce((sum, o) => sum + (o.usage?.totalTokens ?? 0), 0);
  const orderedObs = [...obs]
    .filter((o) => o.type === "GENERATION" || o.type === "SPAN")
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));

  return (
    <div className="border border-ax-border rounded-lg overflow-hidden">
      <div className="bg-ax-surface-hover px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-3 h-3 text-ax-accent" />
          <span className="text-[10px] text-ax-text-dim uppercase">Langfuse Trace</span>
          {live && <Loader2 className="w-3 h-3 text-ax-accent animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[9px] text-ax-text-dim">
              updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <a
            href={langfuseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-ax-text-dim hover:text-ax-accent flex items-center gap-1"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            Open
          </a>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="flex gap-3 text-[10px] text-ax-text-dim">
          <span>{generations.length} generation{generations.length !== 1 ? "s" : ""}</span>
          <span>{spans.length} span{spans.length !== 1 ? "s" : ""}</span>
          {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
        </div>

        {loading && orderedObs.length === 0 && (
          <div className="text-[11px] text-ax-text-dim">
            Waiting for Langfuse observations…
          </div>
        )}

        {error && (
          <div className="text-[10px] text-ax-error bg-ax-error/10 rounded px-2 py-1">
            {error}
          </div>
        )}

        {orderedObs.length === 0 && !loading && !error && (
          <div className="text-[11px] text-ax-text-dim">
            No Langfuse observations yet.
          </div>
        )}

        {orderedObs.map((o) => {
          const isGen = o.type === "GENERATION";
          const status = o.level === "ERROR" ? "error" : o.endTime ? "done" : "running";
          return (
            <div key={o.id} className="flex items-center gap-2 py-0.5">
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  status === "error"
                    ? "bg-ax-error"
                    : status === "running"
                      ? "bg-ax-warn animate-pulse"
                      : "bg-ax-success"
                }`}
              />
              <span
                className={`text-[9px] px-1 rounded shrink-0 ${
                  isGen ? "bg-ax-primary/20 text-ax-primary" : "bg-ax-tool/20 text-ax-tool"
                }`}
              >
                {isGen ? "GEN" : "SPAN"}
              </span>
              <span className="text-[11px] text-ax-text truncate flex-1 font-mono">
                {o.name}
              </span>
              {o.model && (
                <span className="text-[9px] text-ax-text-dim shrink-0">
                  {o.model.split("/").pop()}
                </span>
              )}
              {o.usage?.totalTokens != null && o.usage.totalTokens > 0 && (
                <span className="text-[9px] text-ax-text-dim shrink-0">
                  {o.usage.totalTokens} tok
                </span>
              )}
            </div>
          );
        })}

        {obs
          .filter((o) => o.statusMessage)
          .map((o) => (
            <div
              key={`err-${o.id}`}
              className="text-[10px] text-ax-error bg-ax-error/10 rounded px-2 py-1 mt-1"
            >
              {o.statusMessage}
            </div>
          ))}
      </div>
    </div>
  );
}

export function TracePanel() {
  const {
    currentTrace,
    isChatStreaming,
    messages,
    backendUrl,
    isAgentForced,
    selectedRunTrace,
    setShowRunHistory,
    isConnected,
  } = useLabStore();

  // If we're inspecting a historical run, use that instead of live trace
  const historicalTrace = selectedRunTrace;

  // Always show the live trace during streaming, or the last message's trace
  const lastMsgTrace = messages[messages.length - 1]?.trace;
  const displayTrace = isChatStreaming
    ? currentTrace
    : historicalTrace
      ? historicalTrace
      : (lastMsgTrace ?? currentTrace);

  const isHistoricalView = !isChatStreaming && historicalTrace !== null;

  // Show demo data only when the backend is disconnected; once connected, an
  // idle trace panel must stay empty until a real run starts.
  const isDisconnectedIdle =
    !isConnected &&
    !isChatStreaming &&
    !lastMsgTrace &&
    !historicalTrace &&
    currentTrace.toolCalls.length === 0 &&
    !currentTrace.mermaidDiagram;

  const toolCalls = isDisconnectedIdle ? DEMO_TRACE : displayTrace.toolCalls;
  const routeDecision = isDisconnectedIdle ? null : displayTrace.routeDecision;

  // Build Mermaid from live trace events (unless the agent provided one)
  const generatedMermaid = useMemo(
    () => buildMermaid(routeDecision, toolCalls),
    [routeDecision, toolCalls],
  );
  const mermaidDiagram = isDisconnectedIdle
    ? DEMO_MERMAID
    : (displayTrace.mermaidDiagram ?? (generatedMermaid || null));

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-2">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          {isHistoricalView ? "Run Trace" : "Live Trace"}
        </span>
        {isHistoricalView && (
          <span className="text-[9px] text-ax-text-dim/50 bg-ax-bg px-1.5 py-0.5 rounded">
            historical
          </span>
        )}
        {displayTrace.isStreaming && (
          <Loader2 className="w-3 h-3 text-ax-primary animate-spin" />
        )}
        {/* Run history button */}
        <button
          onClick={() => setShowRunHistory(true)}
          className="ml-auto p-1 rounded text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover transition-colors"
          title="Run history"
        >
          <Clock className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {!isChatStreaming && toolCalls.length === 0 && !mermaidDiagram && !routeDecision && (
          <div className="flex items-center justify-center h-full text-ax-text-dim">
            <div className="text-center">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-xs">Send a message to see the trace</p>
            </div>
          </div>
        )}

        {/* Route Decision */}
        {routeDecision && (
          <div className="bg-ax-primary/10 border border-ax-primary/20 rounded-lg p-2.5">
            <div className="text-[10px] text-ax-primary uppercase mb-1 flex items-center gap-2">
              Route Decision
              {isAgentForced && (
                <span className="px-1.5 py-0.5 rounded bg-ax-accent/20 text-ax-accent text-[9px] font-mono">
                  forced
                </span>
              )}
            </div>
            <div className="text-xs text-ax-text">
              <span className="font-mono text-ax-accent">
                {routeDecision.agent}
              </span>
              <span className="text-ax-text-dim mx-1">·</span>
              <span className="text-ax-text-dim">
                {routeDecision.model}
              </span>
              <span className="text-ax-text-dim mx-1">·</span>
              <span className="text-ax-text-dim">
                {routeDecision.mechanism}
              </span>
            </div>
          </div>
        )}

        {displayTrace.langfuseUrl && (
          <LangfuseTraceCard
            langfuseUrl={displayTrace.langfuseUrl}
            backendUrl={backendUrl}
            live={displayTrace.isStreaming}
          />
        )}

        {/* Mermaid Diagram */}
        {mermaidDiagram && (
          <div>
            <div className="text-[10px] text-ax-text-dim uppercase mb-1">
              Flow Diagram
            </div>
            <div className="bg-ax-bg border border-ax-border rounded-lg p-3 overflow-x-auto">
              <MermaidDiagram chart={mermaidDiagram} />
            </div>
          </div>
        )}

        {/* Tool Calls */}
        {toolCalls.length > 0 && (
          <div>
            <div className="text-[10px] text-ax-text-dim uppercase mb-1">
              Tool Calls ({toolCalls.length})
            </div>
            <div className="space-y-1.5">
              {toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} call={tc} />
              ))}
            </div>
          </div>
        )}

        {/* Streaming indicator */}
        {displayTrace.isStreaming && !mermaidDiagram && toolCalls.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-ax-primary animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
