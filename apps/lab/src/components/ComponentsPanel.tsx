"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Bot, Wrench, GitBranch, ExternalLink, Lightbulb, FileText, Loader2, Search, Play, Trash2, Wand2, FlaskConical } from "lucide-react";
import { useLabStore } from "@/lib/store";
import { FlowDetailOverlay } from "./FlowDetailOverlay";

interface AgentData {
  id: string;
  name: string;
  description: string;
  modelTier: string;
  tools: string[];
  triggers: string[];
  handoffs: { allowedTargets: string[] };
}

interface ToolData {
  name: string;
  description: string;
  approvalLevel: number;
  source?: { file: string; line: number; function: string; tuningTips?: string[] };
}

interface FlowSkillData {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  approvalRequired: boolean;
  isAxFlow?: boolean;
  sourceFile?: string;
}

interface ComponentData {
  agents: AgentData[];
  tools: ToolData[];
  flows: FlowSkillData[];
  skills: FlowSkillData[];
}

export function ComponentsPanel() {
  const { backendUrl, isConnected, navigateToSource, bench, sendSignatureToNotebook, sendSignatureToEval, editSignatureInBuilder, removeArtifact, setActivePanel, setEvalMode } = useLabStore();
  const [data, setData] = useState<ComponentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedFlow, setSelectedFlow] = useState<FlowSkillData | null>(null);

  useEffect(() => {
    if (!isConnected) { setLoading(false); return; }
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${backendUrl}/api/components`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed');
      }
      if (!cancelled) setLoading(false);
    }
    fetchData();
    return () => { cancelled = true; };
  }, [isConnected, backendUrl]);

  const f = data
    ? (search
      ? {
          agents: data.agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase()) || a.description.toLowerCase().includes(search.toLowerCase())),
          tools: data.tools.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase())),
          flows: data.flows.filter(f => f.name.toLowerCase().includes(search.toLowerCase()) || (f.description || "").toLowerCase().includes(search.toLowerCase())),
          skills: data.skills.filter(sk => sk.name.toLowerCase().includes(search.toLowerCase()) || (sk.description || "").toLowerCase().includes(search.toLowerCase())),
        }
      : data)
    : { agents: [], tools: [], flows: [], skills: [] };

  const mySignatures = useMemo(
    () =>
      bench.filter((artifact) => {
        if (artifact.kind !== "signature") return false;
        if (!search) return true;
        const s = search.toLowerCase();
        return (
          artifact.name.toLowerCase().includes(s) ||
          artifact.id.toLowerCase().includes(s) ||
          artifact.axString.toLowerCase().includes(s)
        );
      }),
    [bench, search],
  );

  const deleteFromShelf = useCallback(async (id: string) => {
    if (!window.confirm("Delete this signature from the shelf?")) return;
    await removeArtifact(id);
  }, [removeArtifact]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-ax-text-dim">
        <Loader2 className="w-6 h-6 text-ax-primary animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full flex items-center justify-center text-ax-text-dim">
        <div className="text-center">
          <p className="text-sm">{error || "Connect to crew to browse components"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-3">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Registry Dashboard
        </span>
        <span className="text-xs text-ax-text-dim">
          {data.agents.length} agents · {data.tools.length} tools · {data.flows.length} flows · {data.skills.length} skills
        </span>
        <div className="ml-auto flex items-center gap-2 bg-ax-bg border border-ax-border rounded px-2 py-0.5">
          <Search className="w-3 h-3 text-ax-text-dim" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter..."
            className="bg-transparent text-xs text-ax-text outline-none w-40 placeholder:text-ax-text-dim/50"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">

        {/* My Shelf */}
        <section>
          <h2 className="text-sm font-medium text-ax-text flex items-center gap-2 mb-3">
            <Lightbulb className="w-4 h-4 text-ax-primary" />
            My Shelf ({mySignatures.length})
          </h2>
          {mySignatures.length === 0 ? (
            <div className="border border-dashed border-ax-border rounded-lg p-4 text-xs text-ax-text-dim bg-ax-bg/30">
              No saved signatures yet. Build one in the Builder tab, then send it to Notebook or Eval from here.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {mySignatures.map((artifact) => (
                <div key={artifact.id} className="border border-ax-border rounded-lg p-3 space-y-2 bg-ax-bg/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ax-text truncate">{artifact.name}</div>
                      <div className="text-[10px] font-mono text-ax-text-dim/50 truncate">{artifact.id}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => editSignatureInBuilder(artifact.id)}
                        className="p-1 text-ax-text-dim hover:text-ax-primary transition-colors"
                        title="Edit in Builder"
                      >
                        <Wand2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteFromShelf(artifact.id)}
                        className="p-1 text-ax-text-dim hover:text-ax-error transition-colors"
                        title="Delete from Shelf"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <pre className="text-[10px] font-mono text-ax-accent bg-ax-bg rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
                    {artifact.axString}
                  </pre>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => sendSignatureToNotebook(artifact.id)}
                      className="flex items-center gap-1 text-[10px] text-ax-primary hover:text-ax-primary/80 transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      Notebook
                    </button>
                    <button
                      onClick={() => sendSignatureToEval(artifact.id)}
                      className="flex items-center gap-1 text-[10px] text-ax-accent hover:text-ax-accent/80 transition-colors"
                    >
                      <FlaskConical className="w-3 h-3" />
                      Eval
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        {/* Agents */}
        <section>
          <h2 className="text-sm font-medium text-ax-text flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-ax-primary" />
            Agents ({f.agents.length})
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {f.agents.map((agent) => (
              <div key={agent.id} className="border border-ax-border rounded-lg p-3 space-y-2 bg-ax-bg/50">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ax-text">{agent.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    agent.modelTier === 'smart' ? 'bg-ax-primary/20 text-ax-primary' : 'bg-ax-accent/20 text-ax-accent'
                  }`}>
                    {agent.modelTier}
                  </span>
                </div>
                <p className="text-xs text-ax-text-dim line-clamp-2">{agent.description}</p>
                {agent.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.tools.slice(0, 4).map((t) => (
                      <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-ax-tool/15 text-ax-tool font-mono">{t}</span>
                    ))}
                    {agent.tools.length > 4 && <span className="text-[10px] text-ax-text-dim/50">+{agent.tools.length - 4}</span>}
                  </div>
                )}
                <button
                  onClick={() => navigateToSource(`crew/agents/${agent.id}.md`, 1)}
                  className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
                >
                  <FileText className="w-3 h-3" />
                  View instructions
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Tools */}
        <section>
          <h2 className="text-sm font-medium text-ax-text flex items-center gap-2 mb-3">
            <Wrench className="w-4 h-4 text-ax-tool" />
            Tools ({f.tools.length})
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {f.tools.map((tool) => (
              <div key={tool.name} className="border border-ax-border rounded-lg p-2.5 space-y-1 bg-ax-bg/50">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-ax-tool truncate">{tool.name}</span>
                  {tool.approvalLevel > 0 && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-ax-warn/20 text-ax-warn shrink-0">appr</span>
                  )}
                </div>
                <p className="text-[11px] text-ax-text-dim line-clamp-1">{tool.description}</p>
                {tool.source && (
                  <button
                    onClick={() => navigateToSource(tool.source!.file, tool.source!.line)}
                    className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                    <span className="font-mono">{tool.source.file.split('/').pop()}:{tool.source.line}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Flows (ax-native) */}
        <section>
          <h2 className="text-sm font-medium text-ax-text flex items-center gap-2 mb-3">
            <GitBranch className="w-4 h-4 text-ax-accent" />
            Flows ({f.flows.length})
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {f.flows.map((flow) => (
              <div
                key={flow.id}
                className="border border-ax-border rounded-lg p-2.5 space-y-1.5 bg-ax-bg/50 cursor-pointer hover:border-ax-primary/50 hover:bg-ax-surface-hover transition-all"
                onClick={() => setSelectedFlow(flow)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ax-text">{flow.name}</span>
                  <div className="flex gap-1">
                    <span className="text-[9px] px-1 py-0.5 rounded bg-ax-primary/20 text-ax-primary font-mono">flow()</span>
                    {flow.approvalRequired && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-ax-warn/20 text-ax-warn">needs approval</span>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-ax-text-dim line-clamp-1">{flow.description}</p>
                {flow.sourceFile && (
                  <p className="text-[10px] text-ax-text-dim/50 font-mono">{flow.sourceFile.split('/').pop()}</p>
                )}
                {flow.triggers.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {flow.triggers.slice(0, 3).map((t) => (
                      <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">"{t}"</span>
                    ))}
                    {flow.triggers.length > 3 && <span className="text-[10px] text-ax-text-dim/50">+{flow.triggers.length - 3}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Skills (agent-driven, not yet migrated) */}
        {f.skills.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-ax-text flex items-center gap-2 mb-3">
              <GitBranch className="w-4 h-4 text-ax-text-dim" />
              Agent-Driven Skills ({f.skills.length})
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              {f.skills.map((skill) => (
                <div key={skill.id} className="border border-ax-border rounded-lg p-2.5 space-y-1.5 bg-ax-bg/50 opacity-60">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ax-text">{skill.name}</span>
                    {skill.approvalRequired && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-ax-warn/20 text-ax-warn">needs approval</span>
                    )}
                  </div>
                  <p className="text-[11px] text-ax-text-dim line-clamp-1">{skill.description}</p>
                  <p className="text-[10px] text-ax-text-dim/50 italic">Agent-driven — not yet migrated to flow()</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Flow Detail Overlay */}
      {selectedFlow && (
        <FlowDetailOverlay
          flowId={selectedFlow.id}
          flow={selectedFlow}
          onClose={() => setSelectedFlow(null)}
          onRunEval={(flowId) => {
            setActivePanel("eval");
            setEvalMode("flow");
          }}
        />
      )}
    </div>
  );
}
