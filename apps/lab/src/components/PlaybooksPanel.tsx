"use client";

import { useEffect, useState, useCallback } from "react";
import {
  BookOpen,
  RefreshCw,
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Clock,
  Hash,
  ThumbsUp,
  ThumbsDown,
  Trash2,
  Pin,
  PinOff,
  Pencil,
  Plus,
  Check,
  X,
} from "lucide-react";
import { useLabStore } from "@/lib/store";

interface PlaybookAgentSummary {
  id: string;
  name: string;
  bulletCount: number;
  sections: string[];
  updatedAt: string | null;
}

interface PlaybookBullet {
  id: string;
  section: string;
  content: string;
  helpfulCount: number;
  harmfulCount: number;
  updatedAt: string;
  tags: string[];
}

interface PlaybookDetail {
  agentId: string;
  playbook: {
    description: string;
    stats: { bulletCount: number; helpfulCount: number; harmfulCount: number; tokenEstimate: number };
    sections: string[];
    updatedAt: string;
  };
  bullets: PlaybookBullet[];
}

interface PlaybookEvent {
  ts: string;
  status: string;
  skipReason?: string;
  signalKinds?: string[];
  feedback?: string;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function PlaybooksPanel() {
  const { backendUrl, isConnected } = useLabStore();
  const [agents, setAgents] = useState<PlaybookAgentSummary[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlaybookDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["failures_to_avoid"]));
  const [error, setError] = useState<string | null>(null);

  // Editing state
  const [editingBullet, setEditingBullet] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [addingSection, setAddingSection] = useState<string | null>(null);
  const [newBulletContent, setNewBulletContent] = useState("");

  // Learning timeline
  const [events, setEvents] = useState<PlaybookEvent[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const fetchAgents = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/playbooks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [isConnected, backendUrl]);

  const fetchDetail = useCallback(async (agentId: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`${backendUrl}/api/playbooks/${agentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoadingDetail(false);
    }
  }, [backendUrl]);

  const resetPlaybook = useCallback(async (agentId: string) => {
    if (!window.confirm(`Reset ${agentId}'s playbook to seed? All learned failures will be lost.`)) return;
    try {
      const res = await fetch(`${backendUrl}/api/playbooks/${agentId}/reset`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchAgents();
      if (selectedAgent === agentId) fetchDetail(agentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    }
  }, [backendUrl, fetchAgents, selectedAgent, fetchDetail]);

  const bulletMutation = useCallback(async (
    op: "edit" | "delete" | "pin",
    bulletId: string,
    payload?: { content?: string; pinned?: boolean },
  ) => {
    if (!selectedAgent) return;
    try {
      const res = await fetch(
        `${backendUrl}/api/playbooks/${selectedAgent}/bullets/${bulletId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, ...payload }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchDetail(selectedAgent);
      await fetchAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${op} failed`);
    }
  }, [backendUrl, selectedAgent, fetchDetail, fetchAgents]);

  const addBullet = useCallback(async (section: string, content: string) => {
    if (!selectedAgent) return;
    try {
      const res = await fetch(
        `${backendUrl}/api/playbooks/${selectedAgent}/bullets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, content }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchDetail(selectedAgent);
      await fetchAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    }
  }, [backendUrl, selectedAgent, fetchDetail, fetchAgents]);

  const startEditing = (bullet: PlaybookBullet) => {
    setEditingBullet(bullet.id);
    setEditContent(bullet.content);
  };

  const commitEdit = () => {
    if (editingBullet && editContent.trim()) {
      bulletMutation("edit", editingBullet, { content: editContent.trim() });
    }
    setEditingBullet(null);
    setEditContent("");
  };

  const cancelEdit = () => {
    setEditingBullet(null);
    setEditContent("");
  };

  const commitAdd = () => {
    if (addingSection && newBulletContent.trim()) {
      addBullet(addingSection, newBulletContent.trim());
    }
    setAddingSection(null);
    setNewBulletContent("");
  };

  const fetchEvents = useCallback(async () => {
    if (!selectedAgent) return;
    setLoadingEvents(true);
    try {
      const res = await fetch(`${backendUrl}/api/playbooks/${selectedAgent}/events?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.events ?? []);
    } catch {
      // Timeline is non-critical
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }, [backendUrl, selectedAgent]);

  // Teach-a-lesson state
  const [showTeachForm, setShowTeachForm] = useState(false);
  const [teachFeedback, setTeachFeedback] = useState("");
  const [teaching, setTeaching] = useState(false);

  const submitTeach = async () => {
    if (!selectedAgent || !teachFeedback.trim()) return;
    setTeaching(true);
    setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/playbooks/${selectedAgent}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: teachFeedback.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTeachFeedback("");
      setShowTeachForm(false);
      await fetchDetail(selectedAgent);
      await fetchAgents();
      await fetchEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Teach failed");
    } finally {
      setTeaching(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (selectedAgent) fetchDetail(selectedAgent);
  }, [selectedAgent, fetchDetail]);

  // Evolve state (B3/C4)
  const [showEvolve, setShowEvolve] = useState(false);
  const [datasets, setDatasets] = useState<Array<{ id: string; caseCount: number }>>([]);
  const [evolveDatasetId, setEvolveDatasetId] = useState("");
  const [evolving, setEvolving] = useState(false);
  const [evolveProgress, setEvolveProgress] = useState<Array<{ phase: string; message: string }>>([]);
  const [evolveResult, setEvolveResult] = useState<{
    baseline: { heldIn: number; heldOut?: number };
    final: { heldIn: number; heldOut?: number };
    outcomes: Array<{ accepted: boolean; reason: string; heldIn: { before: number; after: number } }>;
    bulletCount: number;
    metricCallsUsed: number;
  } | null>(null);

  const fetchDatasets = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/datasets`);
      if (!res.ok) return;
      const data = await res.json();
      setDatasets(
        (data.datasets ?? []).map((d: { id: string; caseCount: number }) => ({
          id: d.id,
          caseCount: d.caseCount,
        })),
      );
    } catch {
      // Datasets are non-critical
    }
  };

  const startEvolve = async () => {
    if (!selectedAgent || !evolveDatasetId || evolving) return;
    setEvolving(true);
    setEvolveProgress([]);
    setEvolveResult(null);
    setError(null);

    try {
      const res = await fetch(`${backendUrl}/api/playbooks/${selectedAgent}/evolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: evolveDatasetId, maxProposals: 3, runsPerTask: 2 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "error") {
                setError(data.error ?? String(data));
              } else if (currentEvent === "done" && data.baseline) {
                setEvolveResult(data);
                const accepted = data.outcomes?.filter((o: any) => o.accepted).length ?? 0;
                setEvolveProgress((prev) => [
                  ...prev,
                  { phase: "done", message: `${accepted} accepted` },
                ]);
              } else if (currentEvent === "progress") {
                setEvolveProgress((prev) => [
                  ...prev,
                  { phase: data.phase ?? "", message: data.message ?? "" },
                ]);
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evolve failed");
    } finally {
      setEvolving(false);
      await fetchDetail(selectedAgent);
      await fetchAgents();
      await fetchEvents();
    }
  };

const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  // Group bullets by section, sort pinned first
  const bulletsBySection: Record<string, PlaybookBullet[]> = {};
  if (detail) {
    for (const b of detail.bullets) {
      if (!bulletsBySection[b.section]) bulletsBySection[b.section] = [];
      bulletsBySection[b.section].push(b);
    }
    // Sort pinned bullets to top within each section
    for (const bullets of Object.values(bulletsBySection)) {
      bullets.sort((a, b) => {
        const aPinned = a.tags.includes("pinned") ? -1 : 0;
        const bPinned = b.tags.includes("pinned") ? -1 : 0;
        return aPinned - bPinned;
      });
    }
  }

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-3">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Playbooks
        </span>
        <button
          onClick={fetchAgents}
          className="flex items-center gap-1 text-xs text-ax-text-dim hover:text-ax-text transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
        {loading && <Loader2 className="w-3 h-3 text-ax-primary animate-spin" />}
        {error && <span className="text-xs text-ax-error truncate">{error}</span>}
      </div>

      {!isConnected ? (
        <div className="flex-1 flex items-center justify-center text-ax-text-dim">
          <p className="text-xs">Connect to crew to browse playbooks</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* Agent list sidebar */}
          <div className="w-56 border-r border-ax-border overflow-y-auto shrink-0">
            {/* Stats header */}
            <div className="px-3 py-2 border-b border-ax-border">
              <div className="text-xs text-ax-text-dim flex items-center gap-1.5">
                <BookOpen className="w-3 h-3" />
                <span>{agents.length} agents</span>
              </div>
              <div className="text-[10px] text-ax-text-dim/50 mt-0.5">
                {agents.reduce((sum, a) => sum + a.bulletCount, 0)} total bullets
              </div>
            </div>
            {agents.map((agent) => {
              const isSelected = selectedAgent === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                  className={`w-full text-left px-3 py-2 border-b border-ax-border/50 transition-colors ${
                    isSelected
                      ? "bg-ax-primary/10 border-l-2 border-l-ax-primary"
                      : "hover:bg-ax-surface-hover"
                  }`}
                >
                  <div className="text-xs font-medium text-ax-text">{agent.name}</div>
                  <div className="text-[10px] text-ax-text-dim flex items-center gap-2 mt-0.5">
                    <span>{agent.bulletCount} bullets</span>
                    <span className="text-ax-text-dim/50">·</span>
                    <span className="flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {timeAgo(agent.updatedAt)}
                    </span>
                  </div>
                  {agent.sections.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {agent.sections.map((s) => (
                        <span key={s} className="text-[9px] px-1 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">
                          {s.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto min-w-0">
            {!selectedAgent ? (
              <div className="flex items-center justify-center h-full text-ax-text-dim">
                <div className="text-center">
                  <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p className="text-xs">Select an agent to view its playbook</p>
                </div>
              </div>
            ) : loadingDetail ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 text-ax-primary animate-spin" />
              </div>
            ) : detail ? (
              <div className="p-4 space-y-4">
                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5 bg-ax-bg rounded px-2 py-1">
                    <Hash className="w-3 h-3 text-ax-text-dim" />
                    <span className="text-ax-text">{detail.playbook.stats.bulletCount} bullets</span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-ax-bg rounded px-2 py-1">
                    <span className="text-ax-text">{detail.playbook.stats.tokenEstimate} tokens</span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-ax-bg rounded px-2 py-1">
                    <Clock className="w-3 h-3 text-ax-text-dim" />
                    <span className="text-ax-text-dim">{timeAgo(detail.playbook.updatedAt)}</span>
                  </div>
                  <button
                    onClick={() => resetPlaybook(detail.agentId)}
                    className="flex items-center gap-1 text-ax-text-dim hover:text-ax-error transition-colors ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                    Reset
                  </button>
                </div>

                {/* Description */}
                {detail.playbook.description && (
                  <p className="text-xs text-ax-text-dim bg-ax-bg/50 rounded p-2 border border-ax-border">
                    {detail.playbook.description}
                  </p>
                )}

                {/* Learning timeline */}
                <div className="border border-ax-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => {
                      setShowTimeline(!showTimeline);
                      if (!showTimeline) fetchEvents();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-ax-bg/50 hover:bg-ax-surface-hover transition-colors text-left"
                  >
                    {showTimeline ? (
                      <ChevronDown className="w-3.5 h-3.5 text-ax-text-dim" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-ax-text-dim" />
                    )}
                    <Sparkles className="w-3 h-3 text-ax-accent" />
                    <span className="text-xs font-medium text-ax-text">
                      Learning activity
                    </span>
                    <span className="text-[10px] text-ax-text-dim/50 ml-auto">
                      {events.length > 0 ? `${events.length} events` : ""}
                    </span>
                  </button>
                  {/* "Teach a lesson" inline */}
                  <div className="border-t border-ax-border px-3 py-2">
                    {showTeachForm ? (
                      <div className="space-y-1.5">
                        <span className="text-[10px] text-ax-text-dim">
                          What should this agent learn to avoid?
                        </span>
                        <textarea
                          value={teachFeedback}
                          onChange={(e) => setTeachFeedback(e.target.value)}
                          placeholder="e.g. Always check X before doing Y…"
                          className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text resize-none focus:outline-none focus:border-ax-primary"
                          rows={2}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && e.metaKey) submitTeach();
                            if (e.key === "Escape") {
                              setShowTeachForm(false);
                              setTeachFeedback("");
                            }
                          }}
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={submitTeach}
                            disabled={teaching || !teachFeedback.trim()}
                            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-ax-primary/20 text-ax-primary hover:bg-ax-primary/30 disabled:opacity-50"
                          >
                            {teaching ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            ) : (
                              <Check className="w-2.5 h-2.5" />
                            )}
                            Teach
                          </button>
                          <button
                            onClick={() => {
                              setShowTeachForm(false);
                              setTeachFeedback("");
                            }}
                            className="text-[10px] px-2 py-0.5 rounded text-ax-text-dim hover:text-ax-text"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowTeachForm(true)}
                        className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
                      >
                        <Sparkles className="w-3 h-3" />
                        Teach a lesson
                      </button>
                    )}
                  </div>
                  {showTimeline && (
                    <div className="border-t border-ax-border">
                      {loadingEvents ? (
                        <div className="flex justify-center py-3">
                          <Loader2 className="w-4 h-4 text-ax-primary animate-spin" />
                        </div>
                      ) : events.length === 0 ? (
                        <p className="text-xs text-ax-text-dim px-3 py-2">
                          No learning events yet. Events appear when an agent completes a run with failure signals.
                        </p>
                      ) : (
                        <div className="divide-y divide-ax-border/50 max-h-64 overflow-y-auto">
                          {events.map((evt, i) => (
                            <div key={i} className="px-3 py-2 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-ax-text-dim">
                                  {timeAgo(evt.ts)}
                                </span>
                                {evt.status === "updated" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-success/10 text-ax-success">
                                    updated
                                  </span>
                                )}
                                {evt.status === "manual-update" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-accent/10 text-ax-accent">
                                    taught
                                  </span>
                                )}
                                {evt.status === "skipped" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">
                                    skipped
                                    {evt.skipReason && (
                                      <span className="ml-1 text-ax-text-dim/50">
                                        ({evt.skipReason.replace(/_/g, " ")})
                                      </span>
                                    )}
                                  </span>
                                )}
                                {evt.status === "unchanged" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-text-dim/10 text-ax-text-dim">
                                    unchanged
                                  </span>
                                )}
                              </div>
                              {evt.signalKinds && evt.signalKinds.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {evt.signalKinds.map((k) => (
                                    <span
                                      key={k}
                                      className="text-[9px] px-1 py-0.5 rounded bg-ax-error/10 text-ax-error"
                                    >
                                      {k}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {evt.feedback && (
                                <p className="text-[10px] text-ax-text-dim leading-relaxed line-clamp-2">
                                  {evt.feedback}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Evolve from dataset */}
                <div className="border border-ax-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => {
                      setShowEvolve(!showEvolve);
                      if (!showEvolve) fetchDatasets();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-ax-bg/50 hover:bg-ax-surface-hover transition-colors text-left"
                  >
                    {showEvolve ? (
                      <ChevronDown className="w-3.5 h-3.5 text-ax-text-dim" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-ax-text-dim" />
                    )}
                    <Sparkles className="w-3 h-3 text-ax-accent" />
                    <span className="text-xs font-medium text-ax-text">
                      Evolve from dataset
                    </span>
                  </button>
                  {showEvolve && (
                    <div className="border-t border-ax-border px-3 py-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={evolveDatasetId}
                          onChange={(e) => setEvolveDatasetId(e.target.value)}
                          disabled={evolving}
                          className="flex-1 bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text focus:outline-none focus:border-ax-primary disabled:opacity-50"
                        >
                          <option value="">Pick a dataset…</option>
                          {datasets.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.id} ({d.caseCount} cases)
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={startEvolve}
                          disabled={evolving || !evolveDatasetId}
                          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-ax-primary/20 text-ax-primary hover:bg-ax-primary/30 disabled:opacity-50"
                        >
                          {evolving ? (
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          ) : (
                            <Sparkles className="w-2.5 h-2.5" />
                          )}
                          Evolve
                        </button>
                      </div>
                      {evolveProgress.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {evolveProgress.map((p, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className="text-ax-text-dim w-16 shrink-0 capitalize">
                                {p.phase}
                              </span>
                              <span className="text-ax-text-dim/70">{p.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {evolveResult && (
                        <div className="border border-ax-border rounded p-2 bg-ax-bg/30 space-y-1.5">
                          <div className="flex items-center gap-3 text-[10px]">
                            <div className="flex items-center gap-1">
                              <span className="text-ax-text-dim">Baseline:</span>
                              <span className="text-ax-text">
                                {evolveResult.baseline.heldIn.toFixed(3)}
                                {evolveResult.baseline.heldOut != null && (
                                  <span className="text-ax-text-dim/50 ml-0.5">
                                    (held-out: {evolveResult.baseline.heldOut.toFixed(3)})
                                  </span>
                                )}
                              </span>
                            </div>
                            <span className="text-ax-text-dim">→</span>
                            <div className="flex items-center gap-1">
                              <span className="text-ax-text-dim">Final:</span>
                              <span
                                className={
                                  evolveResult.final.heldIn > evolveResult.baseline.heldIn
                                    ? "text-ax-success"
                                    : "text-ax-text"
                                }
                              >
                                {evolveResult.final.heldIn.toFixed(3)}
                              </span>
                              {evolveResult.final.heldOut != null && (
                                <span className="text-ax-text-dim/50 ml-0.5">
                                  (held-out: {evolveResult.final.heldOut.toFixed(3)})
                                </span>
                              )}
                            </div>
                            <span className="text-ax-text-dim/50 ml-auto">
                              {evolveResult.metricCallsUsed} calls · {evolveResult.bulletCount} bullets
                            </span>
                          </div>
                          {evolveResult.outcomes.length > 0 && (
                            <div className="divide-y divide-ax-border/50">
                              {evolveResult.outcomes.map((o, i) => (
                                <div
                                  key={i}
                                  className={`flex items-center gap-2 py-1 text-[10px] ${
                                    o.accepted ? "text-ax-success" : "text-ax-text-dim"
                                  }`}
                                >
                                  <span
                                    className={`w-3 h-3 rounded-full shrink-0 ${
                                      o.accepted ? "bg-ax-success/20" : "bg-ax-text-dim/10"
                                    }`}
                                  />
                                  <span className="flex-1">{o.reason}</span>
                                  <span className="font-mono text-ax-text-dim/50">
                                    Δ{o.heldIn.after - o.heldIn.before > 0 ? "+" : ""}
                                    {(o.heldIn.after - o.heldIn.before).toFixed(3)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Sections */}
                {Object.entries(bulletsBySection).map(([section, bullets]) => {
                  const isExpanded = expandedSections.has(section);
                  const totalHelpful = bullets.reduce((s, b) => s + b.helpfulCount, 0);
                  const totalHarmful = bullets.reduce((s, b) => s + b.harmfulCount, 0);

                  return (
                    <div key={section} className="border border-ax-border rounded-lg overflow-hidden">
                      <button
                        onClick={() => toggleSection(section)}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-ax-bg/50 hover:bg-ax-surface-hover transition-colors text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-ax-text-dim" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-ax-text-dim" />
                        )}
                        <span className="text-xs font-medium text-ax-text capitalize">
                          {section.replace(/_/g, " ")}
                        </span>
                        <span className="text-[10px] text-ax-text-dim/50 ml-auto">
                          {bullets.length} bullet{bullets.length !== 1 ? "s" : ""}
                        </span>
                        {totalHelpful > 0 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-ax-success">
                            <ThumbsUp className="w-2.5 h-2.5" />
                            {totalHelpful}
                          </span>
                        )}
                        {totalHarmful > 0 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-ax-error">
                            <ThumbsDown className="w-2.5 h-2.5" />
                            {totalHarmful}
                          </span>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="border-t border-ax-border divide-y divide-ax-border/50">
                          {bullets.map((bullet) => {
                            const isPinned = bullet.tags.includes("pinned");
                            const isEditing = editingBullet === bullet.id;
                            return (
                              <div
                                key={bullet.id}
                                className="px-3 py-2 space-y-1 group hover:bg-ax-bg/30 transition-colors"
                              >
                                {isEditing ? (
                                  <div className="space-y-1.5">
                                    <textarea
                                      value={editContent}
                                      onChange={(e) => setEditContent(e.target.value)}
                                      className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text resize-none focus:outline-none focus:border-ax-primary"
                                      rows={3}
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && e.metaKey) commitEdit();
                                        if (e.key === "Escape") cancelEdit();
                                      }}
                                    />
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={commitEdit}
                                        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-ax-primary/20 text-ax-primary hover:bg-ax-primary/30"
                                      >
                                        <Check className="w-2.5 h-2.5" />
                                        Save
                                      </button>
                                      <button
                                        onClick={cancelEdit}
                                        className="text-[10px] px-2 py-0.5 rounded text-ax-text-dim hover:text-ax-text"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-start gap-2">
                                      {section === "failures_to_avoid" && (
                                        <Sparkles className="w-3 h-3 text-ax-accent shrink-0 mt-0.5" />
                                      )}
                                      {isPinned && (
                                        <Pin className="w-3 h-3 text-ax-accent shrink-0 mt-0.5" />
                                      )}
                                      <p className="text-xs text-ax-text leading-relaxed flex-1">{bullet.content}</p>
                                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                        <button
                                          onClick={() => startEditing(bullet)}
                                          className="p-0.5 rounded hover:bg-ax-border text-ax-text-dim hover:text-ax-text"
                                          title="Edit"
                                        >
                                          <Pencil className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={() =>
                                            bulletMutation("pin", bullet.id, {
                                              pinned: !isPinned,
                                            })
                                          }
                                          className={`p-0.5 rounded hover:bg-ax-border ${
                                            isPinned
                                              ? "text-ax-accent"
                                              : "text-ax-text-dim hover:text-ax-text"
                                          }`}
                                          title={isPinned ? "Unpin" : "Pin"}
                                        >
                                          {isPinned ? (
                                            <PinOff className="w-3 h-3" />
                                          ) : (
                                            <Pin className="w-3 h-3" />
                                          )}
                                        </button>
                                        <button
                                          onClick={() => bulletMutation("delete", bullet.id)}
                                          className="p-0.5 rounded hover:bg-ax-error/10 text-ax-text-dim hover:text-ax-error"
                                          title="Delete"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-ax-text-dim/50 pl-5">
                                      {bullet.helpfulCount > 0 && (
                                        <span className="flex items-center gap-0.5 text-ax-success">
                                          <ThumbsUp className="w-2.5 h-2.5" />
                                          {bullet.helpfulCount}
                                        </span>
                                      )}
                                      {bullet.harmfulCount > 0 && (
                                        <span className="flex items-center gap-0.5 text-ax-error">
                                          <ThumbsDown className="w-2.5 h-2.5" />
                                          {bullet.harmfulCount}
                                        </span>
                                      )}
                                      {isPinned && (
                                        <span className="flex items-center gap-0.5 text-ax-accent">
                                          <Pin className="w-2 h-2" />
                                          pinned
                                        </span>
                                      )}
                                      <span className="text-ax-text-dim/30 font-mono">{bullet.id}</span>
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                          {/* Add rule */}
                          <div className="px-3 py-2">
                            {addingSection === section ? (
                              <div className="space-y-1.5">
                                <textarea
                                  value={newBulletContent}
                                  onChange={(e) => setNewBulletContent(e.target.value)}
                                  placeholder={`Add a rule to ${section.replace(/_/g, " ")}…`}
                                  className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text resize-none focus:outline-none focus:border-ax-primary"
                                  rows={2}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && e.metaKey) commitAdd();
                                    if (e.key === "Escape") {
                                      setAddingSection(null);
                                      setNewBulletContent("");
                                    }
                                  }}
                                />
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={commitAdd}
                                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-ax-primary/20 text-ax-primary hover:bg-ax-primary/30"
                                  >
                                    <Check className="w-2.5 h-2.5" />
                                    Add
                                  </button>
                                  <button
                                    onClick={() => {
                                      setAddingSection(null);
                                      setNewBulletContent("");
                                    }}
                                    className="text-[10px] px-2 py-0.5 rounded text-ax-text-dim hover:text-ax-text"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => setAddingSection(section)}
                                className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors"
                              >
                                <Plus className="w-3 h-3" />
                                Add rule
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-ax-text-dim">
                <p className="text-xs">No playbook data</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
