"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from "react";
import {
  Plus,
  Trash2,
  GripVertical,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Play,
  BookOpen,
  FlaskConical,
  Wand2,
} from "lucide-react";
import { useLabStore } from "@/lib/store";
import {
  type SigField,
  type SignatureSpec,
  type BenchArtifact,
  compileSignature,
  slugify,
  uniqueArtifactId,
  emptySpec,
  parseClassValues,
  scaffoldNotebookCell,
} from "@/lib/bench";

// ---------------------------------------------------------------------------
// Types for the field editor
// ---------------------------------------------------------------------------

const FIELD_TYPES: { value: SigField["type"]; label: string; tooltip: string }[] = [
  { value: "string", label: "string", tooltip: "Text — the most common input/output type" },
  { value: "number", label: "number", tooltip: "A numeric value (integer or float)" },
  { value: "boolean", label: "boolean", tooltip: "True or false" },
  { value: "json", label: "json", tooltip: "Arbitrary structured data — object or array" },
  { value: "date", label: "date", tooltip: "A date without time, e.g. 2026-07-21" },
  { value: "datetime", label: "datetime", tooltip: "A date and time, e.g. 2026-07-21T14:30:00Z" },
  { value: "dateRange", label: "dateRange", tooltip: "A span between two dates" },
  { value: "datetimeRange", label: "datetimeRange", tooltip: "A span between two date-times" },
  { value: "url", label: "url", tooltip: "A web URL" },
  { value: "code", label: "code", tooltip: "A block of source code" },
  { value: "class", label: "class", tooltip: "One of a fixed set of values (enum). Example: spam, ham" },
  { value: "string[]", label: "string[]", tooltip: "A list of text strings" },
  { value: "number[]", label: "number[]", tooltip: "A list of numbers" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newField(): SigField {
  return { name: "", type: "string", optional: false };
}

// ---------------------------------------------------------------------------
// Template gallery — jump-start signatures for common tasks
// ---------------------------------------------------------------------------

interface Template {
  name: string;
  description: string;
  spec: SignatureSpec;
}

const TEMPLATES: Template[] = [
  {
    name: "Spam Classifier",
    description: "Classify an email as spam or ham with a confidence score",
    spec: {
      inputs: [
        { name: "email", type: "string", optional: false },
        { name: "subject", type: "string", optional: false },
      ],
      outputs: [
        { name: "category", type: "class", classValues: ["spam", "ham"] },
        { name: "confidence", type: "number" },
      ],
    },
  },
  {
    name: "Text Summarizer",
    description: "Summarize a document into a paragraph and key bullet points",
    spec: {
      inputs: [
        { name: "document", type: "string", optional: false },
      ],
      outputs: [
        { name: "summary", type: "string" },
        { name: "keyPoints", type: "string[]" },
      ],
    },
  },
  {
    name: "Entity Extractor",
    description: "Pull people, orgs, and dates out of unstructured text",
    spec: {
      inputs: [
        { name: "text", type: "string", optional: false },
      ],
      outputs: [
        { name: "people", type: "string[]" },
        { name: "organizations", type: "string[]" },
        { name: "dates", type: "string[]" },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single field row (used for both inputs & outputs). */
function FieldRow({
  field,
  onChange,
  onRemove,
  canRemove,
  placeholderName,
}: {
  field: SigField;
  onChange: (f: SigField) => void;
  onRemove: () => void;
  canRemove: boolean;
  placeholderName?: string;
}) {
  const isClass = field.type === "class";
  return (
    <div className="flex items-start gap-1.5 py-0.5 group">
      <GripVertical className="w-3 h-3 text-ax-text-dim/30 mt-2 shrink-0 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity" />

      <input
        type="text"
        value={field.name}
        onChange={(e) => onChange({ ...field, name: e.target.value })}
        placeholder={placeholderName ?? "fieldName"}
        spellCheck={false}
        className="w-28 px-1.5 py-1 text-xs font-mono bg-ax-bg border border-ax-border rounded text-ax-text placeholder:text-ax-text-dim/40 focus:outline-none focus:border-ax-primary"
      />

      <select
        value={field.type}
        onChange={(e) =>
          onChange({
            ...field,
            type: e.target.value as SigField["type"],
            classValues:
              e.target.value !== "class" ? undefined : field.classValues ?? [],
          })
        }
        className="w-28 px-1 py-1 text-xs bg-ax-bg border border-ax-border rounded text-ax-text focus:outline-none focus:border-ax-primary"
      >
        {FIELD_TYPES.map((t) => (
          <option key={t.value} value={t.value} title={t.tooltip}>
            {t.label}
          </option>
        ))}
      </select>

      {isClass && (
        <input
          type="text"
          value={(field.classValues ?? []).join(", ")}
          onChange={(e) =>
            onChange({ ...field, classValues: parseClassValues(e.target.value) })
          }
          placeholder="spam, ham"
          spellCheck={false}
          className="w-28 px-1.5 py-1 text-xs font-mono bg-ax-bg border border-ax-border rounded text-ax-accent placeholder:text-ax-text-dim/40 focus:outline-none focus:border-ax-primary"
        />
      )}

      <input
        type="text"
        value={field.description ?? ""}
        onChange={(e) =>
          onChange({
            ...field,
            description: e.target.value || undefined,
          })
        }
        placeholder="description"
        className="flex-1 px-1.5 py-1 text-xs bg-ax-bg border border-ax-border rounded text-ax-text-dim placeholder:text-ax-text-dim/40 focus:outline-none focus:border-ax-primary"
      />

      <label className="flex items-center gap-0.5 text-[10px] text-ax-text-dim shrink-0 cursor-pointer">
        <input
          type="checkbox"
          checked={!!field.optional}
          onChange={(e) => onChange({ ...field, optional: e.target.checked })}
          className="w-3 h-3 accent-ax-primary"
        />
        opt
      </label>

      <button
        onClick={onRemove}
        disabled={!canRemove}
        className="p-0.5 text-ax-text-dim/30 hover:text-ax-error transition-colors disabled:opacity-20 shrink-0"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SignatureBuilder() {
  const {
    bench,
    saveArtifact,
    removeArtifact,
    getArtifact,
    builderArtifactId,
    setBuilderArtifactId,
    backendUrl,
    isConnected,
    pushToNotebook,
    sendSignatureToNotebook,
    sendSignatureToEval,
  } = useLabStore();

  const [name, setName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [spec, setSpec] = useState<SignatureSpec>(emptySpec());
  const [validation, setValidation] = useState<{
    pending: boolean;
    ok?: boolean;
    error?: string;
  }>({ pending: false });
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Derived
  const slug = useMemo(() => slugify(name) || "untitled", [name]);
  const axStr = useMemo(() => {
    try {
      return compileSignature(spec);
    } catch {
      return "// invalid spec";
    }
  }, [spec]);

  const mySignatures = useMemo(
    () => bench.filter((a) => a.kind === "signature"),
    [bench],
  );

  // Debounced validation
  const validate = useCallback(
    (axString: string) => {
      if (!axString || axString === " -> " || !isConnected) {
        setValidation({ pending: false });
        return;
      }
      setValidation({ pending: true });
      const ax = axString;
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`${backendUrl}/api/bench/validate-signature`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ axString: ax }),
          });
          const data = (await res.json()) as { ok: boolean; error?: string };
          setValidation({ pending: false, ok: data.ok, error: data.error });
        } catch {
          setValidation({ pending: false });
        }
      }, 400);
    },
    [backendUrl, isConnected],
  );

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    validate(axStr);
  }, [axStr, validate]);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!builderArtifactId) return;
    const artifact = getArtifact(builderArtifactId);
    if (!artifact || artifact.kind !== "signature") return;
    setEditId(artifact.id);
    setName(artifact.name);
    setSpec(artifact.spec);
    setSaveOk(false);
  }, [builderArtifactId, getArtifact]);

  // Edit an existing artifact
  const onEdit = useCallback(
    (artifact: BenchArtifact) => {
      setBuilderArtifactId(artifact.id);
      setEditId(artifact.id);
      setName(artifact.name);
      setSpec(artifact.spec);
      setSaveOk(false);
      setSaveMessage(null);
    },
    [setBuilderArtifactId],
  );

  const onNew = useCallback(() => {
    setBuilderArtifactId(null);
    setEditId(null);
    setName("");
    setSpec(emptySpec());
    setSaveOk(false);
    setSaveMessage(null);
  }, [setBuilderArtifactId]);

  // Save
  const onSave = useCallback(async () => {
    if (!name.trim() || !axStr || validation.ok === false) return;
    setSaving(true);
    setSaveMessage(null);
    const now = Date.now();
    const existing = editId ? getArtifact(editId) : null;
    const nextId = uniqueArtifactId(slug, bench, editId);
    const artifact: BenchArtifact = {
      id: nextId,
      name: name.trim(),
      kind: "signature",
      spec,
      axString: axStr,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await saveArtifact(artifact);
    if (saved && editId && editId !== saved.id) {
      await removeArtifact(editId);
    }
    setSaving(false);
    if (saved) {
      setSaveOk(true);
      setEditId(saved.id);
      setBuilderArtifactId(saved.id);
      setSaveMessage(saved.id === slug ? "Saved" : `Slug taken — saved as ${saved.id}`);
      setTimeout(() => {
        setSaveOk(false);
        setSaveMessage(null);
      }, 2500);
    }
  }, [name, axStr, slug, spec, editId, getArtifact, bench, saveArtifact, removeArtifact, validation.ok, setBuilderArtifactId]);

  // Delete
  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this signature from the shelf?")) return;
      await removeArtifact(id);
      if (editId === id) onNew();
    },
    [editId, removeArtifact, onNew],
  );

  // Send to Notebook
  const onSendToNotebook = useCallback(
    (artifact: BenchArtifact) => {
      sendSignatureToNotebook(artifact.id);
    },
    [sendSignatureToNotebook],
  );

  // Send to Eval
  const onSendToEval = useCallback(
    (artifact: BenchArtifact) => {
      sendSignatureToEval(artifact.id);
    },
    [sendSignatureToEval],
  );

  // Field list helpers
  const addInput = () =>
    setSpec((s) => ({ ...s, inputs: [...s.inputs, newField()] }));
  const addOutput = () =>
    setSpec((s) => ({ ...s, outputs: [...s.outputs, newField()] }));

  const updateInput = (idx: number, f: SigField) =>
    setSpec((s) => ({
      ...s,
      inputs: s.inputs.map((x, i) => (i === idx ? f : x)),
    }));
  const updateOutput = (idx: number, f: SigField) =>
    setSpec((s) => ({
      ...s,
      outputs: s.outputs.map((x, i) => (i === idx ? f : x)),
    }));

  const removeInput = (idx: number) =>
    setSpec((s) => ({
      ...s,
      inputs: s.inputs.length > 1 ? s.inputs.filter((_, i) => i !== idx) : s.inputs,
    }));
  const removeOutput = (idx: number) =>
    setSpec((s) => ({
      ...s,
      outputs:
        s.outputs.length > 1 ? s.outputs.filter((_, i) => i !== idx) : s.outputs,
    }));

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-3">
        <Wand2 className="w-3.5 h-3.5 text-ax-primary" />
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Signature Builder
        </span>
        {editId && (
          <span className="text-[10px] font-mono text-ax-text-dim/60">
            editing: {editId}
          </span>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Template gallery — only shown when not editing an existing artifact */}
          {!editId && (
            <div className="space-y-2">
              <label className="text-[11px] text-ax-text-dim uppercase tracking-wider">
                Start from a template
              </label>
              <div className="grid grid-cols-3 gap-2">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => {
                      setName(t.name);
                      setSpec(t.spec);
                      setSaveOk(false);
                      setSaveMessage(null);
                    }}
                    className="text-left p-2.5 rounded-lg border border-ax-border bg-ax-bg hover:border-ax-primary/40 hover:bg-ax-surface-hover transition-colors group"
                  >
                    <div className="text-xs font-medium text-ax-text group-hover:text-ax-primary transition-colors">
                      {t.name}
                    </div>
                    <div className="text-[10px] text-ax-text-dim/60 mt-0.5 leading-relaxed">
                      {t.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px] text-ax-text-dim uppercase tracking-wider">
              Signature Name
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaveOk(false);
                }}
                placeholder="Email Classifier"
                className="flex-1 px-2 py-1 text-sm bg-ax-bg border border-ax-border rounded text-ax-text placeholder:text-ax-text-dim/40 focus:outline-none focus:border-ax-primary"
              />
              <span className="text-[10px] font-mono text-ax-text-dim/50">
                id: {slug}
              </span>
            </div>
          </div>

          {/* Inputs */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-ax-text-dim uppercase tracking-wider">
                Inputs
              </label>
              <button
                onClick={addInput}
                className="flex items-center gap-1 text-[10px] text-ax-primary hover:text-ax-primary/80 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add input
              </button>
            </div>
            <div className="bg-ax-bg border border-ax-border rounded-lg p-2 space-y-0.5">
              {spec.inputs.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  onChange={(nf) => updateInput(i, nf)}
                  onRemove={() => removeInput(i)}
                  canRemove={spec.inputs.length > 1}
                  placeholderName={["email", "text", "query", "document", "input"][i] ?? "inputField"}
                />
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-ax-border" />
            <span className="text-[10px] text-ax-text-dim/50 font-mono">→</span>
            <div className="flex-1 h-px bg-ax-border" />
          </div>

          {/* Outputs */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-ax-text-dim uppercase tracking-wider">
                Outputs
              </label>
              <button
                onClick={addOutput}
                className="flex items-center gap-1 text-[10px] text-ax-primary hover:text-ax-primary/80 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add output
              </button>
            </div>
            <div className="bg-ax-bg border border-ax-border rounded-lg p-2 space-y-0.5">
              {spec.outputs.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  onChange={(nf) => updateOutput(i, nf)}
                  onRemove={() => removeOutput(i)}
                  canRemove={spec.outputs.length > 1}
                  placeholderName={["category", "summary", "result", "confidence", "output"][i] ?? "outputField"}
                />
              ))}
            </div>
          </div>

          {/* Save row */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onSave}
              disabled={!name.trim() || saving || validation.ok === false}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-primary text-white hover:bg-ax-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCircle className="w-3 h-3" />
              )}
              {editId ? "Update" : "Save to Shelf"}
            </button>

            {/* Run in Notebook — scaffold the current spec directly */}
            {validation.ok === true && name.trim() && (
              <button
                onClick={() => {
                  const code = scaffoldNotebookCell({
                    id: slug,
                    name: name.trim(),
                    kind: "signature",
                    spec,
                    axString: axStr,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  });
                  pushToNotebook(code);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-ax-bg border border-ax-border text-ax-text hover:bg-ax-surface-hover transition-colors"
              >
                <Play className="w-3 h-3" />
                Run in Notebook
              </button>
            )}

            {saveOk && saveMessage && (
              <span className="text-[10px] text-ax-success flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> {saveMessage}
              </span>
            )}

            {validation.pending && (
              <span className="text-[10px] text-ax-text-dim/60 flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin" /> validating...
              </span>
            )}

            {!validation.pending && validation.ok === true && (
              <span className="text-[10px] text-ax-success flex items-center gap-1">
                <CheckCircle className="w-2.5 h-2.5" /> valid
              </span>
            )}

            {!validation.pending && validation.ok === false && validation.error && (
              <span className="text-[10px] text-ax-error flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" /> {validation.error}
              </span>
            )}
          </div>

          {/* Live preview */}
          <div className="space-y-1.5">
            <label className="text-[10px] text-ax-text-dim/40 uppercase tracking-wider">
              This is the ax code you&apos;re building
            </label>
            <pre className="text-xs font-mono text-ax-accent bg-ax-bg border border-ax-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              ax(&quot;{axStr}&quot;)
            </pre>
          </div>
        </div>

        {/* Right: My Signatures sidebar */}
        <div className="w-72 border-l border-ax-border flex flex-col shrink-0 overflow-hidden">
          <div className="h-8 border-b border-ax-border flex items-center px-3 shrink-0">
            <BookOpen className="w-3 h-3 text-ax-primary mr-1.5" />
            <span className="text-[11px] text-ax-text-dim uppercase tracking-wider">
              My Signatures ({mySignatures.length})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {mySignatures.length === 0 && (
              <p className="text-[11px] text-ax-text-dim/50 text-center mt-8 px-2">
                Build your first signature and save it to the shelf.
              </p>
            )}
            {mySignatures.map((a) => {
              const isActive = editId === a.id;
              return (
                <div
                  key={a.id}
                  className={`border rounded-lg p-2.5 space-y-1.5 transition-colors ${
                    isActive
                      ? "border-ax-primary/50 bg-ax-primary/5"
                      : "border-ax-border bg-ax-bg/50 hover:border-ax-border/80"
                  }`}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-ax-text truncate">
                        {a.name}
                      </div>
                      <div className="text-[10px] font-mono text-ax-text-dim/50 truncate">
                        {a.id}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => onEdit(a)}
                        className="p-0.5 text-ax-text-dim/40 hover:text-ax-primary transition-colors"
                        title="Edit"
                      >
                        <Wand2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onDelete(a.id)}
                        className="p-0.5 text-ax-text-dim/40 hover:text-ax-error transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  <pre className="text-[10px] font-mono text-ax-text-dim/60 bg-ax-bg rounded px-1.5 py-1 overflow-x-auto whitespace-pre-wrap break-all">
                    {a.axString}
                  </pre>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onSendToNotebook(a)}
                      className="flex items-center gap-1 text-[10px] text-ax-primary/70 hover:text-ax-primary transition-colors"
                      title="Send to Notebook"
                    >
                      <Play className="w-2.5 h-2.5" /> Notebook
                    </button>
                    <button
                      onClick={() => onSendToEval(a)}
                      className="flex items-center gap-1 text-[10px] text-ax-accent/70 hover:text-ax-accent transition-colors"
                      title="Send to Eval"
                    >
                      <FlaskConical className="w-2.5 h-2.5" /> Eval
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
