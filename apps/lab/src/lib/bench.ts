// Shared shelf (the "Bench") — in-app registry of user-built ax artifacts.
// Types, compiler, and helpers used by the Signature Builder, Notebook scaffold,
// and backend validator so everyone agrees on the ax string.

export type ArtifactKind = "signature" | "generator" | "agent" | "flow" | "orchestrator";

export interface SigField {
  name: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "json"
    | "date"
    | "datetime"
    | "dateRange"
    | "datetimeRange"
    | "url"
    | "code"
    | "class"
    | "string[]"
    | "number[]";
  description?: string;
  optional?: boolean;
  /** Only when type === "class" — the allowed enum values. */
  classValues?: string[];
}

export interface SignatureSpec {
  inputs: SigField[];
  outputs: SigField[];
}

export interface BenchArtifact {
  id: string; // kebab slug, unique on the shelf
  name: string; // display name
  kind: ArtifactKind; // "signature" for now
  spec: SignatureSpec; // agent/flow specs added later, same envelope
  axString: string; // compiled, e.g. `email:string -> category:class "spam, ham", urgency:number`
  createdAt: number;
  updatedAt: number;
}

/** Map a SigField.type to its ax string suffix (without the colon or optional marker). */
const TYPE_TO_AX: Record<SigField["type"], (f: SigField) => string> = {
  string: () => "string",
  number: () => "number",
  boolean: () => "boolean",
  json: () => "json",
  date: () => "date",
  datetime: () => "datetime",
  dateRange: () => "dateRange",
  datetimeRange: () => "datetimeRange",
  url: () => "url",
  code: () => "code",
  class: (f) => `class "${(f.classValues ?? []).join(", ")}"`,
  "string[]": () => "string[]",
  "number[]": () => "number[]",
};

function fieldToAxString(f: SigField): string {
  const optional = f.optional ? "?" : "";
  const suffix = TYPE_TO_AX[f.type](f);
  return `${f.name}${optional}:${suffix}`;
}

/**
 * Compile a SignatureSpec to a valid ax signature string.
 * No description prefix; we keep it minimal so Ben learns the raw syntax.
 */
export function compileSignature(spec: SignatureSpec): string {
  const inputs = spec.inputs.map(fieldToAxString).join(", ");
  const outputs = spec.outputs.map(fieldToAxString).join(", ");
  return `${inputs} -> ${outputs}`;
}

/** Parse a comma-separated list of class values. */
export function parseClassValues(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Create a kebab-slug from a display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled";
}

/** Choose a unique artifact id, appending -2, -3, ... when needed. */
export function uniqueArtifactId(
  baseId: string,
  artifacts: Array<{ id: string }>,
  currentId?: string | null,
): string {
  const taken = new Set(
    artifacts
      .map((artifact) => artifact.id)
      .filter((id) => id !== currentId),
  );
  if (!taken.has(baseId)) return baseId;
  let n = 2;
  while (taken.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

/** Return a blank signature spec with one empty input and one empty output row. */
export function emptySpec(): SignatureSpec {
  return {
    inputs: [{ name: "", type: "string", optional: false }],
    outputs: [{ name: "", type: "string", optional: false }],
  };
}

/** Convert a display name to a camelCase JS identifier. */
export function camelize(name: string): string {
  return name
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ?? "").toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/** Build a scaffolded notebook cell from a bench artifact. */
export function scaffoldNotebookCell(artifact: BenchArtifact): string {
  const cName = camelize(artifact.name);
  const spec = artifact.spec;
  const inputExample = spec.inputs
    .filter((f) => f.name)
    .map((f) => {
      const val =
        f.type === "string" || f.type === "code" || f.type === "url"
          ? '"..."'
          : f.type === "number"
            ? "0"
            : f.type === "boolean"
              ? "false"
              : f.type === "class"
                ? `"${f.classValues?.[0] ?? "value"}"`
                : "{}";
      return `  ${f.name}: ${val}`;
    })
    .join(",\n");

  return [
    `// Signature: ${artifact.name}  (from the shelf)`,
    `const ${cName} = ax("${artifact.axString}");`,
    inputExample ? `const r = await ${cName}.forward(llm, {` : `const r = await ${cName}.forward(llm, {});`,
    inputExample,
    inputExample ? `});` : "",
    `r`,
  ]
    .filter(Boolean)
    .join("\n");
}
