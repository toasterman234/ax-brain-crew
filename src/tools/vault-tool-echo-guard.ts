// Guard against an agent passing the raw result of a vault.read tool call as
// the content of a vault.write/vault.append call — i.e. it read a note, then
// wrote back its own tool-result object (`{path, content, modifiedAt, size}`)
// instead of extracting `.content` and synthesizing real text (incident-008
// follow-up: the investigator did exactly this with
// `Templates/incident-report.md`). Structural check, not a string-prefix
// guess: parse as JSON and look for the exact VaultReadOutput shape.
export function looksLikeToolResultEcho(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return (
    typeof obj.path === 'string' &&
    typeof obj.content === 'string' &&
    typeof obj.modifiedAt === 'string' &&
    typeof obj.size === 'number'
  );
}
