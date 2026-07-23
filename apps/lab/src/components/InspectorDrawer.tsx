"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Bot,
  Wrench,
  GitBranch,
  BookOpen,
  X,
  ExternalLink,
  Lightbulb,
  Zap,
  Loader2,
  Search,
  FileText,
  Code2,
  BarChart3,
} from "lucide-react";
import { useLabStore } from "@/lib/store";
import { FlowDetailOverlay } from "./FlowDetailOverlay";
import { PlaybooksPanel } from "./PlaybooksPanel";

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

interface SkillData {
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
  flows: SkillData[];
  skills: SkillData[];
}

export function InspectorDrawer() {
  const { inspectorTab, setInspectorTab, toggleInspector, backendUrl, isConnected, navigateToSource, setActivePanel, setEvalMode } = useLabStore();
  const [data, setData] = useState<ComponentData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedFlow, setSelectedFlow] = useState<SkillData | null>(null);
  const [flowEvals, setFlowEvals] = useState<Record<string, { accuracy: number; runs: number }>>({});

  useEffect(() => {
    if (!isConnected) return;
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

  // Phase 6: Fetch eval summaries for flows to show inline badges
  useEffect(() => {
    if (!isConnected) return;
    fetch(`${backendUrl}/api/eval/experiments?targetType=flow`)
      .then((r) => r.json())
      .then((d) => {
        const map: Record<string, { accuracy: number; runs: number }> = {};
        for (const exp of (d.experiments ?? [])) {
          if (exp.target_id && exp.latest_run) {
            map[exp.target_id] = { accuracy: exp.latest_run.accuracy, runs: exp.run_count };
          }
        }
        setFlowEvals(map);
      })
      .catch(() => {});
  }, [isConnected, backendUrl]);

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Inspector
        </span>
        <button
          onClick={toggleInspector}
          className="p-0.5 ml-auto rounded text-ax-text-dim hover:text-ax-text transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex border-b border-ax-border">
        {[
          { id: "agents" as const, label: `Agents${data ? ` (${data.agents.length})` : ""}`, icon: Bot },
          { id: "tools" as const, label: `Tools${data ? ` (${data.tools.length})` : ""}`, icon: Wrench },
          { id: "flows" as const, label: `Flows${data ? ` (${data.flows.length})` : ""}`, icon: GitBranch },
          { id: "playbooks" as const, label: "Playbooks", icon: BookOpen },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = inspectorTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setInspectorTab(tab.id)}
              className={`flex items-center gap-1 px-3 py-2 text-xs transition-colors ${
                isActive
                  ? "text-ax-primary border-b border-ax-primary"
                  : "text-ax-text-dim hover:text-ax-text"
              }`}
            >
              <Icon className="w-3 h-3" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 7F: Search filter */}
      <div className="px-3 py-2 border-b border-ax-border">
        <div className="flex items-center gap-2 bg-ax-bg border border-ax-border rounded px-2 py-1">
          <Search className="w-3 h-3 text-ax-text-dim" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Filter ${inspectorTab}...`}
            className="flex-1 bg-transparent text-xs text-ax-text outline-none placeholder:text-ax-text-dim/50"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-ax-text-dim hover:text-ax-text">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-ax-primary animate-spin" />
          </div>
        )}
        {error && (
          <div className="text-xs text-ax-error bg-ax-error/10 rounded p-2">
            Failed to load: {error}
          </div>
        )}

        {!isConnected && !data && (
          <div className="text-center py-12 text-ax-text-dim">
            <p className="text-xs">Connect to crew to browse components</p>
          </div>
        )}

        {data && inspectorTab === "agents" &&
          data.agents
            .filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.description.toLowerCase().includes(search.toLowerCase()))
            .map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}

        {data && inspectorTab === "tools" &&
          data.tools
            .filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
            .map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}

        {data && inspectorTab === "flows" &&
          data.flows
            .filter((s) => !search || s.name.toLowerCase().includes(search.toLowerCase()) || (!s.description ? false : s.description.toLowerCase().includes(search.toLowerCase())))
            .map((flow) => (
            <FlowCard key={flow.id} flow={flow} onClick={() => setSelectedFlow(flow)} evals={flowEvals[flow.id]} />
          ))}

        {inspectorTab === "playbooks" && <PlaybooksPanel />}
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

function AgentCard({ agent }: { agent: AgentData }) {
  const navigateToSource = useLabStore((s) => s.navigateToSource);
  const pushToNotebook = useLabStore((s) => s.pushToNotebook);
  const setInspectorTab = useLabStore((s) => s.setInspectorTab);
  return (
    <div className="border border-ax-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ax-text">{agent.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${agent.modelTier === 'smart' ? 'bg-ax-primary/20 text-ax-primary' : 'bg-ax-accent/20 text-ax-accent'}`}>
          {agent.modelTier}
        </span>
      </div>
      <p className="text-xs text-ax-text-dim">{agent.description}</p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => navigateToSource(`crew/agents/${agent.id}.md`, 1)}
          className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
        >
          <FileText className="w-3 h-3" />
          View instructions
        </button>
        <button
          onClick={() => setInspectorTab("playbooks")}
          className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-accent transition-colors"
        >
          <BookOpen className="w-3 h-3" />
          View playbook
        </button>
        <button
          onClick={() => pushToNotebook(
            `// Chat with ${agent.name} directly\n// Agent: ${agent.id} | Model: ${agent.modelTier}\n// Tools: ${agent.tools.join(', ')}\n\nconst response = await fetch("http://127.0.0.1:8788/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({\n    model: "${agent.id}",\n    messages: [{ role: "user", content: "YOUR_QUERY_HERE" }],\n    stream: false,\n  }),\n});\nconst data = await response.json();\ndata;`
          )}
          className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-accent transition-colors"
        >
          <Code2 className="w-3 h-3" />
          Use in notebook
        </button>
      </div>
      {agent.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.tools.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-ax-tool/15 text-ax-tool font-mono">
              {t}
            </span>
          ))}
        </div>
      )}
      {agent.triggers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.triggers.slice(0, 5).map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">
              "{t}"
            </span>
          ))}
          {agent.triggers.length > 5 && (
            <span className="text-[10px] text-ax-text-dim/50">+{agent.triggers.length - 5} more</span>
          )}
        </div>
      )}
      {agent.handoffs.allowedTargets.length > 0 && (
        <div className="text-[10px] text-ax-text-dim">
          ↳ handoffs: {agent.handoffs.allowedTargets.join(', ')}
        </div>
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolData }) {
  const navigateToSource = useLabStore((s) => s.navigateToSource);
  return (
    <div className="border border-ax-border rounded-lg p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono text-ax-tool">{tool.name}</span>
        {tool.approvalLevel > 0 && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-ax-warn/20 text-ax-warn">
            approval required
          </span>
        )}
      </div>
      <p className="text-xs text-ax-text-dim">{tool.description}</p>
      {tool.source && (
        <button
          onClick={() => navigateToSource(tool.source!.file, tool.source!.line)}
          className="flex items-center gap-1.5 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
        >
          <ExternalLink className="w-3 h-3" />
          <span className="font-mono">{tool.source.file}:{tool.source.line}</span>
          <span className="text-ax-primary">{tool.source.function}()</span>
        </button>
      )}
      {tool.source?.tuningTips && tool.source.tuningTips.length > 0 && (
        <div className="space-y-0.5 mt-1">
          {tool.source.tuningTips.map((tip, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px] text-ax-text-dim/70">
              <Lightbulb className="w-3 h-3 text-ax-warn shrink-0 mt-px" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// All flows from the ax-native registry are self-identified with isAxFlow=true
function FlowCard({ flow, onClick, evals }: { flow: SkillData; onClick?: () => void; evals?: { accuracy: number; runs: number } }) {
  const navigateToSource = useLabStore((s) => s.navigateToSource);
  const pushToNotebook = useLabStore((s) => s.pushToNotebook);
  const isAxFlow = flow.isAxFlow ?? false;
  return (
    <div
      className="border border-ax-border rounded-lg p-3 space-y-2 cursor-pointer hover:border-ax-primary/50 hover:bg-ax-surface-hover transition-all"
      onClick={(e) => {
        if (onClick && !(e.target as HTMLElement).closest('button')) {
          onClick();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ax-text">{flow.name}</span>
        <div className="flex gap-1">
          {isAxFlow && (
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
      </div>
      <p className="text-xs text-ax-text-dim">{flow.description}</p>
      {evals && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 bg-ax-bg rounded-full overflow-hidden">
            <div className="h-full bg-ax-success rounded-full" style={{ width: `${evals.accuracy * 100}%` }} />
          </div>
          <span className="text-[10px] font-mono text-ax-text-dim">
            {(evals.accuracy * 100).toFixed(0)}% · {evals.runs} run{evals.runs !== 1 ? 's' : ''}
          </span>
        </div>
      )}
      {!isAxFlow && (
        <div className="text-[10px] text-ax-text-dim/50 italic">
          Agent-driven — not yet migrated to flow()
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        {flow.sourceFile && (
          <button
            onClick={() => navigateToSource(flow.sourceFile!, 1)}
            className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
          >
            <FileText className="w-3 h-3" />
            View source
          </button>
        )}
        {isAxFlow && (
          <button
            onClick={() => pushToNotebook(
              `// Run the "${flow.name}" flow directly\n// Triggers: ${flow.triggers.slice(0, 3).join(', ')}\n// Source: ${flow.sourceFile || 'src/flows/' + flow.id + '.ts'}\n\n// Send a request that triggers this flow:\nconst response = await fetch("http://127.0.0.1:8788/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({\n    model: "crew",\n    messages: [{ role: "user", content: "${flow.triggers[0] || 'YOUR_REQUEST'}"}],\n    stream: false,\n  }),\n});\nconst data = await response.json();\ndata;`
            )}
            className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-accent transition-colors"
          >
            <Code2 className="w-3 h-3" />
            Run in notebook
          </button>
        )}
      </div>
      {flow.triggers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flow.triggers.slice(0, 4).map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">
              "{t}"
            </span>
          ))}
          {flow.triggers.length > 4 && (
            <span className="text-[10px] text-ax-text-dim/50">+{flow.triggers.length - 4} more</span>
          )}
        </div>
      )}
    </div>
  );
}
