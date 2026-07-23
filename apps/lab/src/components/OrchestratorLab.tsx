"use client";

// Orchestrator Lab — the EXPERIMENT SURFACE (Slice Q-rewire, real backend).
//
// Connected to the real API:
//   - variants     → GET /api/orchestrators (load on mount)
//   - save         → POST /api/orchestrators (upsert)
//   - delete       → DELETE /api/orchestrators/:id
//   - run          → POST /api/orchestrators/run (SSE stream, parsed live)
//   - snapshots    → GET /api/playbooks/conductor/snapshots (playbook picker)
//   - activate     → POST /api/orchestrators/active (opt-in per-run via activate button)
//
// All types mirror the backend's OrchestratorConfig field-for-field.

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Copy,
  Trash2,
  Play,
  Pencil,
  GitBranch,
  ArrowRight,
  Loader2,
  Check,
  Plus,
  RefreshCw,
  Zap,
  Search,
  Database,
  Brain,
  FileText,
} from "lucide-react";

// ── Types (mirror src/composition/orchestrator-config.ts) ──────────
type Mode = "router" | "orchestrator";

interface VariantConfig {
  id: string;
  name: string;
  mode: Mode;
  specialistIds: string[];
  directResponse: "off" | "auto";
  maxSteps: number;
  signature: string;
  identity: string;
  playbookSnapshotId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TraceStep {
  kind: "route" | "specialist" | "tool" | "final";
  agent?: string;
  detail: string;
}

const ALL_SPECIALISTS = [
  "seeker",
  "scout",
  "scribe",
  "librarian",
  "sorter",
  "architect",
  "connector",
  "investigator",
];

const BACKEND = "http://127.0.0.1:8788";

function newVariant(id: string): VariantConfig {
  return {
    id,
    name: id,
    mode: "router",
    specialistIds: ALL_SPECIALISTS,
    directResponse: "off",
    maxSteps: 1,
    signature: "userRequest:string -> routingSummary:string",
    identity: "",
    playbookSnapshotId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const STEP_COLOR: Record<TraceStep["kind"], string> = {
  route: "text-ax-accent",
  specialist: "text-ax-primary",
  tool: "text-ax-text-dim",
  final: "text-ax-success",
};

// ── API helpers ────────────────────────────────────────────────────────────
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BACKEND}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

// ── Real run: SSE stream from /api/orchestrators/run ───────────────────────
async function runVariantSSE(
  configId: string,
  request: string,
  onStep: (step: TraceStep) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  const res = await fetch(`${BACKEND}/api/orchestrators/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configId, request }),
  });

  if (!res.ok) {
    onError(`${res.status}: ${await res.text()}`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onError("No response stream");
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7).trim();
          continue;
        }
        if (!trimmed.startsWith("data: ")) continue;
        const payload = JSON.parse(trimmed.slice(6));

        if (currentEvent === "error") {
          onError(payload.error ?? "Unknown error");
          return;
        }

        if (currentEvent === "done") {
          const trace = payload.trace as {
            steps: Array<{
              specialistId: string;
              input: string;
              output: string;
              durationMs: number;
            }>;
            finalAnswer: string;
          } | null;

          if (trace?.steps) {
            onStep({ kind: "route", detail: `orchestrator started (${trace.steps.length} specialist calls planned)` });
            for (const s of trace.steps) {
              onStep({
                kind: "specialist",
                agent: s.specialistId,
                detail: s.input.slice(0, 120),
              });
              onStep({
                kind: "tool",
                agent: s.specialistId,
                detail: `${s.durationMs}ms · ${s.output.slice(0, 200)}`,
              });
            }
          }
          if (payload.output && typeof payload.output === "string") {
            const out = payload.output as string;
            const firstLine = out.split("\n")[0]?.trim().slice(0, 200) ?? "";
            onStep({ kind: "final", detail: firstLine || `routed to ${payload.routedAgent ?? "?"}` });
          }
          onDone();
          return;
        }
      }
    }
  } catch (err) {
    onError(String(err));
  }
}

// ── Split trace column ─────────────────────────────────────────────────────
function TraceColumn({
  variant,
  steps,
  running,
  revealed,
}: {
  variant: VariantConfig | null;
  steps: TraceStep[];
  running: boolean;
  revealed: number;
}) {
  if (!variant) {
    return (
      <div className="h-full flex items-center justify-center text-ax-text-dim text-xs">
        Pick a variant
      </div>
    );
  }
  const shown = steps.slice(0, revealed);
  const specialists = steps.filter((s) => s.kind === "specialist").map((s) => s.agent);
  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-ax-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ax-text">{variant.name}</span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              variant.mode === "orchestrator"
                ? "bg-ax-primary/20 text-ax-primary"
                : "bg-ax-surface-hover text-ax-text-dim"
            }`}
          >
            {variant.mode}
          </span>
        </div>
        <div className="text-[10px] text-ax-text-dim mt-1 font-mono truncate">
          {variant.signature}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-1.5">
        {shown.length === 0 && !running && (
          <div className="text-xs text-ax-text-dim">Idle — press Run.</div>
        )}
        {shown.map((s, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className={`font-mono ${STEP_COLOR[s.kind]}`}>{s.kind}</span>
            {s.agent && <span className="text-ax-text">{s.agent}</span>}
            <span className="text-ax-text-dim">{s.detail}</span>
          </div>
        ))}
        {running && revealed < steps.length && (
          <div className="flex items-center gap-2 text-xs text-ax-text-dim">
            <Loader2 className="w-3 h-3 animate-spin" /> running…
          </div>
        )}
      </div>
      {revealed >= steps.length && steps.length > 0 && (
        <div className="px-3 py-2 border-t border-ax-border shrink-0 text-[10px] text-ax-text-dim">
          {specialists.length} specialist call{specialists.length === 1 ? "" : "s"} ·{" "}
          {steps.length} steps
        </div>
      )}
    </div>
  );
}

// ── Variant edit card ──────────────────────────────────────────────────────
function VariantCard({
  v,
  selectedAs,
  onEdit,
  onDuplicate,
  onDelete,
  onActivate,
  isActive,
  onSelectA,
  onSelectB,
}: {
  v: VariantConfig;
  selectedAs: "A" | "B" | null;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onActivate: () => void;
  isActive: boolean;
  onSelectA: () => void;
  onSelectB: () => void;
}) {
  return (
    <div
      className={`border rounded p-2.5 bg-ax-surface ${
        isActive ? "border-ax-primary/50" : "border-ax-border"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ax-text flex-1 truncate">{v.name}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            v.mode === "orchestrator"
              ? "bg-ax-primary/20 text-ax-primary"
              : "bg-ax-surface-hover text-ax-text-dim"
          }`}
        >
          {v.mode}
        </span>
        {isActive && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-ax-success/20 text-ax-success">
            active
          </span>
        )}
      </div>
      <div className="text-[10px] text-ax-text-dim mt-1">
        {v.specialistIds.length} specialists · maxSteps {v.maxSteps} · directResponse{" "}
        {v.directResponse} · snapshot: {v.playbookSnapshotId ?? "live"}
      </div>
      <div className="flex items-center gap-1 mt-2">
        <button
          onClick={onSelectA}
          className={`text-[10px] px-2 py-0.5 rounded ${
            selectedAs === "A"
              ? "bg-ax-accent/25 text-ax-accent"
              : "text-ax-text-dim hover:bg-ax-surface-hover"
          }`}
        >
          A
        </button>
        <button
          onClick={onSelectB}
          className={`text-[10px] px-2 py-0.5 rounded ${
            selectedAs === "B"
              ? "bg-ax-primary/25 text-ax-primary"
              : "text-ax-text-dim hover:bg-ax-surface-hover"
          }`}
        >
          B
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={onActivate}
            title="Set as active orchestrator (live dispatch)"
            className={`p-1 rounded ${
              isActive ? "text-ax-success" : "text-ax-text-dim hover:text-ax-text"
            }`}
          >
            <Zap className="w-3 h-3" />
          </button>
          <button onClick={onEdit} title="Edit" className="p-1 text-ax-text-dim hover:text-ax-text">
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={onDuplicate}
            title="Duplicate as new variation"
            className="p-1 text-ax-text-dim hover:text-ax-text"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button onClick={onDelete} title="Delete" className="p-1 text-ax-text-dim hover:text-ax-error">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function EditForm({
  v,
  onSave,
  onCancel,
}: {
  v: VariantConfig;
  onSave: (v: VariantConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<VariantConfig>(v);
  const [saving, setSaving] = useState(false);
  const toggleSpecialist = (id: string) =>
    setDraft((d) => ({
      ...d,
      specialistIds: d.specialistIds.includes(id)
        ? d.specialistIds.filter((s) => s !== id)
        : [...d.specialistIds, id],
    }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-ax-primary/40 rounded p-3 bg-ax-surface space-y-2">
      <input
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-sm text-ax-text"
        placeholder="Variant name"
      />
      <div className="flex gap-2 text-xs">
        <label className="flex items-center gap-1 text-ax-text-dim">
          mode
          <select
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as Mode })}
            className="bg-ax-bg border border-ax-border rounded px-1 py-0.5 text-ax-text"
          >
            <option value="router">router</option>
            <option value="orchestrator">orchestrator</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-ax-text-dim">
          maxSteps
          <input
            type="number"
            value={draft.maxSteps}
            onChange={(e) => setDraft({ ...draft, maxSteps: Number(e.target.value) })}
            className="w-14 bg-ax-bg border border-ax-border rounded px-1 py-0.5 text-ax-text"
          />
        </label>
        <label className="flex items-center gap-1 text-ax-text-dim">
          directResponse
          <select
            value={draft.directResponse}
            onChange={(e) =>
              setDraft({ ...draft, directResponse: e.target.value as "off" | "auto" })
            }
            className="bg-ax-bg border border-ax-border rounded px-1 py-0.5 text-ax-text"
          >
            <option value="off">off</option>
            <option value="auto">auto</option>
          </select>
        </label>
      </div>
      <input
        value={draft.signature}
        onChange={(e) => setDraft({ ...draft, signature: e.target.value })}
        className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs font-mono text-ax-text"
        placeholder="ax signature"
      />
      <textarea
        value={draft.identity}
        onChange={(e) => setDraft({ ...draft, identity: e.target.value })}
        className="w-full bg-ax-bg border border-ax-border rounded px-2 py-1 text-xs text-ax-text h-14 resize-none"
        placeholder="identity / instructions"
      />
      <div>
        <div className="text-[10px] text-ax-text-dim mb-1">specialists</div>
        <div className="flex flex-wrap gap-1">
          {ALL_SPECIALISTS.map((id) => (
            <button
              key={id}
              onClick={() => toggleSpecialist(id)}
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                draft.specialistIds.includes(id)
                  ? "bg-ax-primary/20 text-ax-primary"
                  : "bg-ax-surface-hover text-ax-text-dim"
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-1 text-xs text-ax-text-dim">
        playbook snapshot
        <input
          value={draft.playbookSnapshotId ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, playbookSnapshotId: e.target.value || null })
          }
          className="flex-1 bg-ax-bg border border-ax-border rounded px-2 py-0.5 text-ax-text"
          placeholder="null = live, or a snapshot id"
        />
      </label>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="text-xs px-2 py-1 text-ax-text-dim hover:text-ax-text">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs px-2 py-1 rounded bg-ax-primary/20 text-ax-primary flex items-center gap-1 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export function OrchestratorLab({ onClose }: { onClose: () => void }) {
  const [variants, setVariants] = useState<VariantConfig[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [aId, setAId] = useState<string | null>(null);
  const [bId, setBId] = useState<string | null>(null);
  const [request, setRequest] = useState(
    "research the vault's incidents then summarize them",
  );
  const [running, setRunning] = useState(false);
  const [aSteps, setASteps] = useState<TraceStep[]>([]);
  const [bSteps, setBSteps] = useState<TraceStep[]>([]);
  const [revealedA, setRevealedA] = useState(0);
  const [revealedB, setRevealedB] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // ── Prompt feed state ───────────────────────────────────────
  type FeedTab = "crew" | "agentmemory" | "vault";
  const [feedTab, setFeedTab] = useState<FeedTab>("crew");
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedSearch, setFeedSearch] = useState("");
  const [feedRoute, setFeedRoute] = useState("");
  const [feedItems, setFeedItems] = useState<Array<{ id: string; text: string; sub: string; date?: string }>>([]);
  const [feedLoading, setFeedLoading] = useState(false);

  const ALL_ROUTES = ["seeker","conductor","scribe","sorter","investigator","architect","librarian","scout","connector"];

  const fetchFeed = async () => {
    setFeedLoading(true);
    try {
      if (feedTab === "crew") {
        const params = new URLSearchParams();
        if (feedSearch) params.set("q", feedSearch);
        if (feedRoute) params.set("route", feedRoute);
        params.set("limit", "30");
        const data = await apiGet<{ runs: Array<{ id: string; original_request: string; selected_route_id: string | null; started_at: string; request_preview: string }> }>(`/api/runs?${params}`);
        setFeedItems(data.runs.map((r) => ({ id: r.id, text: r.original_request, sub: r.selected_route_id ?? "unknown", date: r.started_at })));
      } else if (feedTab === "agentmemory") {
        const data = await apiGet<{ sessions: Array<{ id: string; firstPrompt?: string; project: string; startedAt: string; observationCount: number }> }>("/api/agentmemory/sessions");
        const sessions = data.sessions.filter((s) => s.firstPrompt && s.firstPrompt.length > 10);
        const filtered = feedSearch ? sessions.filter((s) => s.firstPrompt!.toLowerCase().includes(feedSearch.toLowerCase()) || s.project.toLowerCase().includes(feedSearch.toLowerCase())) : sessions;
        setFeedItems(filtered.slice(0, 30).map((s) => ({ id: s.id, text: s.firstPrompt!, sub: `${s.project} · ${s.observationCount} obs`, date: s.startedAt })));
      } else {
        // Vault: reuse /api/files to read a note index
        setFeedItems([
          { id: "vault-meta", text: "Vault note browser — pick a note to load its content as a prompt", sub: "Use /api/files?path=vault/Meta/...", date: new Date().toISOString() },
        ]);
      }
    } catch (err) {
      setError(`Feed load failed: ${String(err)}`);
    } finally {
      setFeedLoading(false);
    }
  };

  const openFeed = (tab: FeedTab) => {
    setFeedTab(tab);
    setFeedSearch("");
    setFeedRoute("");
    setFeedOpen(true);
  };

  useEffect(() => { if (feedOpen) fetchFeed(); }, [feedTab, feedOpen]);

  // ── Load variants + active id on mount ──────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vData, aData] = await Promise.all([
        apiGet<{ configs: VariantConfig[] }>("/api/orchestrators"),
        apiGet<{ activeId: string | null; config: VariantConfig | null }>(
          "/api/orchestrators/active",
        ),
      ]);
      setVariants(vData.configs);
      setActiveId(aData.activeId);
      // Auto-select A/B if not already set
      const ids = vData.configs.map((v) => v.id);
      setAId((prev) => (prev && ids.includes(prev) ? prev : ids[0] ?? null));
      setBId((prev) => (prev && ids.includes(prev) ? prev : ids[1] ?? ids[0] ?? null));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── CRUD ────────────────────────────────────────────────────────
  const saveVariant = async (next: VariantConfig) => {
    try {
      await apiPost("/api/orchestrators", {
        ...next,
        updatedAt: Date.now(),
        createdAt: next.createdAt || Date.now(),
      });
      setVariants((vs) => vs.map((v) => (v.id === next.id ? next : v)));
      setEditingId(null);
    } catch (err) {
      setError(`Save failed: ${String(err)}`);
    }
  };

  const duplicate = async (v: VariantConfig) => {
    const copy: VariantConfig = {
      ...v,
      id: `${v.id}-copy-${Date.now()}`,
      name: `${v.name} (copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await apiPost("/api/orchestrators", copy);
      setVariants((vs) => [...vs, copy]);
      setEditingId(copy.id);
    } catch (err) {
      setError(`Duplicate failed: ${String(err)}`);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiDelete(`/api/orchestrators/${id}`);
      setVariants((vs) => vs.filter((v) => v.id !== id));
      if (aId === id) setAId(null);
      if (bId === id) setBId(null);
      if (activeId === id) setActiveId(null);
    } catch (err) {
      setError(`Delete failed: ${String(err)}`);
    }
  };

  const activate = async (id: string) => {
    try {
      await apiPost("/api/orchestrators/active", { id });
      setActiveId(id);
    } catch (err) {
      setError(`Activate failed: ${String(err)}`);
    }
  };

  const deactivate = async () => {
    try {
      await apiPost("/api/orchestrators/active", { id: null });
      setActiveId(null);
    } catch (err) {
      setError(`Deactivate failed: ${String(err)}`);
    }
  };

  const createNew = () => {
    const id = `variant-${Date.now()}`;
    setVariants((vs) => [...vs, newVariant(id)]);
    setEditingId(id);
  };

  // ── Run ──────────────────────────────────────────────────────────
  const run = async () => {
    if (!variantA && !variantB) return;
    setASteps([]);
    setBSteps([]);
    setRevealedA(0);
    setRevealedB(0);
    setRunError(null);
    setRunning(true);

    const aDone = { done: false };
    const bDone = { done: false };

    const reveal = (which: "A" | "B") => {
      if (which === "A") setRevealedA((r) => r + 1);
      else setRevealedB((r) => r + 1);
    };

    const checkDone = () => {
      if (aDone.done && bDone.done) setRunning(false);
    };

    const runners: Promise<void>[] = [];

    if (variantA) {
      runners.push(
        runVariantSSE(
          variantA.id,
          request,
          (step) => {
            setASteps((s) => [...s, step]);
            reveal("A");
          },
          () => {
            aDone.done = true;
            checkDone();
          },
          (err) => {
            setASteps((s) => [...s, { kind: "final", detail: `Error: ${err}` }]);
            setRunError(err);
            aDone.done = true;
            checkDone();
          },
        ),
      );
    } else {
      aDone.done = true;
    }

    if (variantB) {
      runners.push(
        runVariantSSE(
          variantB.id,
          request,
          (step) => {
            setBSteps((s) => [...s, step]);
            reveal("B");
          },
          () => {
            bDone.done = true;
            checkDone();
          },
          (err) => {
            setBSteps((s) => [...s, { kind: "final", detail: `Error: ${err}` }]);
            setRunError(err);
            bDone.done = true;
            checkDone();
          },
        ),
      );
    } else {
      bDone.done = true;
    }

    try {
      await Promise.all(runners);
    } catch (err) {
      setRunError(String(err));
      setRunning(false);
    }
  };

  const variantA = variants.find((v) => v.id === aId) ?? null;
  const variantB = variants.find((v) => v.id === bId) ?? null;

  // Diff strip
  const aCalls = aSteps.filter((s) => s.kind === "specialist").map((s) => s.agent);
  const bCalls = bSteps.filter((s) => s.kind === "specialist").map((s) => s.agent);

  return (
    <div className="fixed inset-0 z-50 bg-ax-bg flex flex-col">
      {/* Header */}
      <header className="h-10 border-b border-ax-border flex items-center px-3 shrink-0">
        <GitBranch className="w-4 h-4 text-ax-primary mr-2" />
        <span className="text-sm font-medium text-ax-text">Orchestrator Lab</span>
        {activeId && (
          <button
            onClick={deactivate}
            className="text-[10px] text-ax-success ml-2 px-1.5 py-0.5 rounded bg-ax-success/10 hover:bg-ax-success/20"
            title="Click to deactivate"
          >
            live: {activeId}
          </button>
        )}
        {!activeId && variants.length > 0 && (
          <span className="text-[10px] text-ax-text-dim ml-2">no active config (dispatch uses linear chain)</span>
        )}
        {error && (
          <span className="text-[10px] text-ax-error ml-auto mr-2 truncate max-w-[300px]">{error}</span>
        )}
        <button
          onClick={load}
          title="Refresh"
          className="p-1 text-ax-text-dim hover:text-ax-text ml-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button onClick={onClose} className="p-1 text-ax-text-dim hover:text-ax-text">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* Left: variant shelf */}
        <div className="w-[320px] border-r border-ax-border flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-ax-border flex items-center gap-2 text-xs text-ax-text-dim">
            Variants — pick <span className="text-ax-accent">A</span> and{" "}
            <span className="text-ax-primary">B</span> to compare
            <button
              onClick={createNew}
              className="ml-auto p-1 text-ax-text-dim hover:text-ax-text flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> new
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {loading && (
              <div className="flex items-center gap-2 text-xs text-ax-text-dim py-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading variants…
              </div>
            )}
            {!loading && variants.length === 0 && (
              <div className="text-xs text-ax-text-dim py-2">
                No saved variants yet.{" "}
                <button onClick={createNew} className="text-ax-primary hover:underline">
                  Create one
                </button>
                .
              </div>
            )}
            {variants.map((v) =>
              editingId === v.id ? (
                <EditForm
                  key={v.id}
                  v={v}
                  onSave={saveVariant}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <VariantCard
                  key={v.id}
                  v={v}
                  selectedAs={aId === v.id ? "A" : bId === v.id ? "B" : null}
                  onEdit={() => setEditingId(v.id)}
                  onDuplicate={() => duplicate(v)}
                  onDelete={() => remove(v.id)}
                  onActivate={() => activate(v.id)}
                  isActive={activeId === v.id}
                  onSelectA={() => setAId(v.id)}
                  onSelectB={() => setBId(v.id)}
                />
              ),
            )}
          </div>
        </div>

        {/* Right: compare */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Compare bar */}
          <div className="p-3 border-b border-ax-border flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <input
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                className="flex-1 bg-ax-bg border border-ax-border rounded px-3 py-1.5 text-sm text-ax-text"
                placeholder="One request to run through both variants…"
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => openFeed("crew")}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] ${feedOpen && feedTab === "crew" ? "bg-ax-accent/20 text-ax-accent" : "text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover"}`}
                  title="Crew history"
                >
                  <Database className="w-3 h-3" /> Crew
                </button>
                <button
                  onClick={() => openFeed("agentmemory")}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] ${feedOpen && feedTab === "agentmemory" ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover"}`}
                  title="Agentmemory sessions"
                >
                  <Brain className="w-3 h-3" /> Memory
                </button>
                <button
                  onClick={() => openFeed("vault")}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] ${feedOpen && feedTab === "vault" ? "bg-ax-success/20 text-ax-success" : "text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover"}`}
                  title="Vault notes"
                >
                  <FileText className="w-3 h-3" /> Vault
                </button>
              </div>
              <button
                onClick={run}
                disabled={running}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-ax-primary/20 text-ax-primary text-sm disabled:opacity-50"
              >
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                Run both
              </button>
            </div>
            {/* Prompt feed panel */}
            {feedOpen && (
              <div className="border border-ax-border rounded bg-ax-surface">
                <div className="flex items-center gap-2 px-2 py-1 border-b border-ax-border">
                  <div className="flex gap-0.5">
                    {(["crew", "agentmemory", "vault"] as FeedTab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setFeedTab(t)}
                        className={`text-[10px] px-2 py-0.5 rounded ${feedTab === t ? "bg-ax-primary/20 text-ax-primary" : "text-ax-text-dim hover:text-ax-text"}`}
                      >
                        {t === "crew" ? "Crew History" : t === "agentmemory" ? "Agentmemory" : "Vault Notes"}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 flex items-center gap-1">
                    <Search className="w-3 h-3 text-ax-text-dim" />
                    <input
                      value={feedSearch}
                      onChange={(e) => setFeedSearch(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") fetchFeed(); }}
                      className="flex-1 bg-ax-bg border-0 text-xs text-ax-text py-0.5 outline-none"
                      placeholder={feedTab === "agentmemory" ? "filter by prompt or project…" : "search…"}
                    />
                    {feedTab === "crew" && (
                      <select
                        value={feedRoute}
                        onChange={(e) => setFeedRoute(e.target.value)}
                        className="bg-ax-bg border border-ax-border rounded px-1 py-0.5 text-[10px] text-ax-text"
                      >
                        <option value="">all routes</option>
                        {ALL_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                    <button onClick={fetchFeed} className="p-0.5 text-ax-text-dim hover:text-ax-text">
                      <RefreshCw className={`w-3 h-3 ${feedLoading ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  <button onClick={() => setFeedOpen(false)} className="p-0.5 text-ax-text-dim hover:text-ax-text">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="max-h-[200px] overflow-auto">
                  {feedLoading && (
                    <div className="flex items-center gap-2 text-[10px] text-ax-text-dim p-2">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                    </div>
                  )}
                  {!feedLoading && feedItems.length === 0 && (
                    <div className="text-[10px] text-ax-text-dim p-2">No results. Try a different tab or search term.</div>
                  )}
                  {feedItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => { setRequest(item.text); setFeedOpen(false); }}
                      className="w-full text-left px-3 py-1.5 border-b border-ax-border/30 hover:bg-ax-surface-hover text-xs group"
                    >
                      <div className="text-ax-text line-clamp-1">{item.text}</div>
                      <div className="text-[10px] text-ax-text-dim flex items-center gap-2 mt-0.5">
                        <span>{item.sub}</span>
                        {item.date && <span>{new Date(item.date).toLocaleDateString()}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Error banner */}
          {runError && (
            <div className="px-3 py-1.5 bg-ax-error/10 border-b border-ax-error/30 text-[11px] text-ax-error shrink-0">
              {runError}
            </div>
          )}

          {/* Diff strip */}
          {(aCalls.length > 0 || bCalls.length > 0) && (
            <div className="px-3 py-2 border-b border-ax-border text-[11px] flex items-center gap-3 shrink-0">
              <span className="text-ax-accent">A: {aCalls.join(" → ") || "—"}</span>
              <ArrowRight className="w-3 h-3 text-ax-text-dim" />
              <span className="text-ax-primary">B: {bCalls.join(" → ") || "—"}</span>
              <span className="ml-auto text-ax-text-dim">
                {aSteps.length} vs {bSteps.length} steps
              </span>
            </div>
          )}

          {/* Split trace */}
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 border-r border-ax-border">
              <TraceColumn variant={variantA} steps={aSteps} running={running} revealed={revealedA} />
            </div>
            <div className="flex-1 min-w-0">
              <TraceColumn variant={variantB} steps={bSteps} running={running} revealed={revealedB} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
