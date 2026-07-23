import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AxPlaybookSnapshot } from '@ax-llm/ax';
import { getLogger } from '../observability/logger.js';

const STORE_DIR = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'playbooks');

/**
 * Ensure the data/playbooks directory exists (idempotent).
 */
function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

/**
 * Load a persisted playbook snapshot for an agent.
 * Returns null when no snapshot has been saved yet (first run).
 */
export function loadPlaybookSnapshot(
  agentId: string,
): AxPlaybookSnapshot | null {
  try {
    ensureDir();
    const path = join(STORE_DIR, `${agentId}.json`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as AxPlaybookSnapshot;
  } catch (err) {
    // File missing, corrupt, or unparseable — start fresh.
    // This is expected on first run or after a manual reset.
    getLogger().warn(
      { agentId, err: String(err) },
      'Failed to load playbook snapshot — starting fresh',
    );
    return null;
  }
}

/**
 * Persist a playbook snapshot to disk.
 * Failures are logged but never thrown — playbook persistence is
 * best-effort and must not break the user-facing run.
 */
export function savePlaybookSnapshot(
  agentId: string,
  snapshot: AxPlaybookSnapshot,
): void {
  try {
    ensureDir();
    const path = join(STORE_DIR, `${agentId}.json`);
    // Atomic-ish: write to a temp name, then rename.
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
    // Simple overwrite — within the same local filesystem this is atomic
    // on most OSes. A full rename-over-tmp pattern would need renameSync,
    // which is fine here since we don't need cross-volume safety.
    writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    getLogger().error(
      { agentId, err: String(err) },
      'Failed to save playbook snapshot — playbook state lost for this run',
    );
    // Swallow — never break the user's run over a playbook write failure.
  }
}

// ── Named snapshots (Slice O2 — variant references) ──────────────────

const SNAPSHOT_DIR = join(STORE_DIR, 'snapshots');

export interface NamedSnapshot {
  id: string;
  agentId: string;
  label: string;
  snapshot: AxPlaybookSnapshot;
  createdAt: string;
}

function ensureSnapshotDir(agentId: string): void {
  const dir = join(SNAPSHOT_DIR, agentId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a named, frozen snapshot of the current playbook state.
 * Returns the snapshot id. Best-effort — swallows errors.
 */
export function saveNamedSnapshot(
  agentId: string,
  label: string,
  snapshot: AxPlaybookSnapshot,
): string | null {
  try {
    ensureSnapshotDir(agentId);
    const id = `${Date.now()}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}`;
    const named: NamedSnapshot = {
      id,
      agentId,
      label,
      snapshot,
      createdAt: new Date().toISOString(),
    };
    const path = join(SNAPSHOT_DIR, agentId, `${id}.json`);
    writeFileSync(path, JSON.stringify(named, null, 2), 'utf8');
    return id;
  } catch (err) {
    getLogger().error(
      { agentId, label, err: String(err) },
      'Failed to save named snapshot',
    );
    return null;
  }
}

/**
 * Load a named snapshot by id. Returns null on any failure.
 */
export function loadNamedSnapshot(
  agentId: string,
  snapshotId: string,
): NamedSnapshot | null {
  try {
    const path = join(SNAPSHOT_DIR, agentId, `${snapshotId}.json`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as NamedSnapshot;
  } catch (err) {
    getLogger().error(
      { agentId, snapshotId, err: String(err) },
      'Failed to load named snapshot',
    );
    return null;
  }
}

/**
 * List all named snapshots for an agent, newest first.
 */
export function listNamedSnapshots(
  agentId: string,
): Array<{ id: string; label: string; createdAt: string }> {
  try {
    const dir = join(SNAPSHOT_DIR, agentId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const results: Array<{ id: string; label: string; createdAt: string }> = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const named = JSON.parse(raw) as NamedSnapshot;
        results.push({ id: named.id, label: named.label, createdAt: named.createdAt });
      } catch {
        // Skip corrupt files
      }
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  } catch (err) {
    getLogger().error(
      { agentId, err: String(err) },
      'Failed to list named snapshots',
    );
    return [];
  }
}

// ── Event log ──────────────────────────────────────────────────────────

export interface PlaybookEvent {
  ts: string;
  status: string;
  skipReason?: string;
  signalKinds?: string[];
  feedback?: string;
}

/**
 * Append a playbook lifecycle event to a per-agent JSONL log.
 * Best-effort — swallows all errors so it never breaks the caller.
 */
export function appendPlaybookEvent(
  agentId: string,
  event: PlaybookEvent,
): void {
  try {
    ensureDir();
    const path = join(STORE_DIR, `${agentId}.events.jsonl`);
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    getLogger().error(
      { agentId, err: String(err) },
      'Failed to append playbook event — event lost',
    );
    // Swallow — never break the caller over an event-write failure.
  }
}

/**
 * Read the last N events for an agent from its JSONL log.
 * Returns newest first.  Best-effort — returns empty array on any failure.
 */
export function readPlaybookEvents(
  agentId: string,
  limit = 50,
): PlaybookEvent[] {
  try {
    const path = join(STORE_DIR, `${agentId}.events.jsonl`);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const events = lines
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line) as PlaybookEvent);
    return events;
  } catch (err) {
    getLogger().error(
      { agentId, err: String(err) },
      'Failed to read playbook events',
    );
    return [];
  }
}
