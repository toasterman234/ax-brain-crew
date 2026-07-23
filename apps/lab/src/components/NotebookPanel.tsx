"use client";

import { useCallback, useEffect, useRef } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Play, Plus, Trash2, Loader2, Code2 } from "lucide-react";
import { useLabStore } from "@/lib/store";
import { MermaidDiagram } from "./MermaidDiagram";

export function NotebookPanel() {
  const { cells, addCell, updateCell, removeCell, runCell } = useLabStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleRunAll = useCallback(async () => {
    for (const cell of cells) {
      if (cell.code.trim()) {
        await runCell(cell.id);
      }
    }
  }, [cells, runCell]);

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 justify-between">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Notebook
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => addCell()}
            className="p-1 rounded text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRunAll}
            className="p-1 rounded text-ax-text-dim hover:text-ax-success hover:bg-ax-surface-hover transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Cells */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {cells.map((cell, idx) => (
          <CellBlock
            key={cell.id}
            cell={cell}
            index={idx}
            onUpdate={(patch) => updateCell(cell.id, patch)}
            onRun={() => runCell(cell.id)}
            onDelete={() => removeCell(cell.id)}
          />
        ))}

        {cells.length === 0 && (
          <div className="flex items-center justify-center h-full text-ax-text-dim">
            <div className="text-center">
              <Code2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-xs">No cells yet. Click + to add one.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CellBlock({
  cell,
  index,
  onUpdate,
  onRun,
  onDelete,
}: {
  cell: ReturnType<typeof useLabStore.getState>["cells"][0];
  index: number;
  onUpdate: (patch: { code?: string }) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const editorRef = useRef<Parameters<Parameters<Monaco["editor"]["create"]>[1]>[0] | null>(null);

  const handleEditorMount = useCallback(
    (
      editor: Parameters<Parameters<Monaco["editor"]["create"]>[1]>[0],
      monaco: Monaco
    ) => {
      editorRef.current = editor;

      // Register ax globals as TypeScript declarations
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        `
declare const ax: any;
declare const llm: any;
declare const ai: any;
declare const agent: any;
declare const flow: any;
`,
        "ax-globals.d.ts"
      );
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Shift+Enter to run
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        onRun();
      }
    },
    [onRun],
  );

  return (
    <div className="border-b border-ax-border">
      {/* Cell header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-ax-text-dim">
        <span className="font-mono text-ax-primary">
          In [{index + 1}]
        </span>
        <span className="text-ax-text-dim/50">
          {new Date(cell.timestamp).toLocaleTimeString()}
        </span>
        <div className="ml-auto flex gap-0.5">
          <button
            onClick={onRun}
            disabled={cell.isRunning}
            className="p-0.5 rounded hover:bg-ax-surface-hover transition-colors disabled:opacity-30"
          >
            {cell.isRunning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Play className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-0.5 rounded hover:bg-ax-surface-hover hover:text-ax-error transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="px-3 pb-2" onKeyDown={handleKeyDown}>
        <div className="border border-ax-border rounded-lg overflow-hidden">
          <Editor
            height={Math.min(Math.max(cell.code.split("\n").length * 20 + 20, 60), 400)}
            defaultLanguage="typescript"
            value={cell.code}
            onChange={(value) => onUpdate({ code: value ?? "" })}
            onMount={handleEditorMount}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              folding: false,
              glyphMargin: false,
              lineDecorationsWidth: 8,
              scrollBeyondLastLine: false,
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              padding: { top: 8, bottom: 8 },
              automaticLayout: true,
              wordWrap: "on",
              renderLineHighlight: "none",
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              scrollbar: {
                vertical: "hidden",
                horizontal: "hidden",
              },
            }}
          />
        </div>
      </div>

      {/* Output */}
      {cell.output !== null && (
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-ax-text-dim uppercase ml-1">
              Out [{index + 1}]
            </span>
            <SaveAsEvalCase cell={cell} />
          </div>
          <CellOutput type={cell.outputType} value={cell.output} />
        </div>
      )}
    </div>
  );
}

function CellOutput({
  type,
  value,
}: {
  type: ReturnType<typeof useLabStore.getState>["cells"][0]["outputType"];
  value: unknown;
}) {
  if (type === "error") {
    return (
      <pre className="text-xs text-ax-error bg-ax-error/5 rounded-lg p-2.5 overflow-x-auto">
        {String(value)}
      </pre>
    );
  }

  if (type === "mermaid" && typeof value === "string") {
    return (
      <div className="bg-ax-bg border border-ax-border rounded-lg p-3 overflow-x-auto">
        <MermaidDiagram chart={value} />
      </div>
    );
  }

  if (type === "html" && typeof value === "string") {
    return (
      <div
        className="text-sm text-ax-text bg-ax-bg rounded-lg p-2.5 overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: value }}
      />
    );
  }

  // Default: JSON tree
  return (
    <pre className="text-xs text-ax-text bg-ax-bg rounded-lg p-2.5 overflow-x-auto max-h-64 font-mono">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}


// 8D: Button to save notebook cell output as an eval case
import { useState } from "react";
import { FlaskConical, Check } from "lucide-react";

function SaveAsEvalCase({ cell }: { cell: ReturnType<typeof useLabStore.getState>["cells"][0] }) {
  const { backendUrl, isConnected } = useLabStore();
  const [saved, setSaved] = useState(false);

  if (!isConnected || cell.outputType === "error" || cell.output === null) return null;

  const handleSave = async () => {
    // Infer which flow this belongs to from the cell code
    const code = cell.code;
    const flowMatch = code.match(/braindump-triage|deep-clean|defrag|prior-art|project-scaffold|tag-garden|triage-route|vault-assess|vault-audit/);
    const flowId = flowMatch ? flowMatch[0] : null;
    
    const caseId = `nb-${Date.now().toString(36)}`;
    const datasetId = flowId ? `${flowId}-cases` : "notebook-cases";
    
    try {
      await fetch(`${backendUrl}/api/datasets/${datasetId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cases: [{
            id: caseId,
            input: { code },
            expected: { result: cell.output },
            metric: "function score(output, expected) { return 1.0; }",
          }],
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* silently fail */ }
  };

  return (
    <button
      onClick={handleSave}
      className="flex items-center gap-1 text-[10px] text-ax-text-dim hover:text-ax-primary transition-colors px-1 py-0.5 rounded hover:bg-ax-surface-hover"
      title="Save cell output as an eval case"
    >
      {saved ? <Check className="w-3 h-3 text-ax-success" /> : <FlaskConical className="w-3 h-3" />}
      {saved ? "Saved" : "Save as eval case"}
    </button>
  );
}
