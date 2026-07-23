import type { AxACEPlaybook, AxACEBullet, AxPlaybookSnapshot } from '@ax-llm/ax';
import { loadPlaybookSnapshot, savePlaybookSnapshot } from './persist.js';
import { seedPlaybook, contentId, estimateTokens } from './seed.js';

// ── Pin tags ──────────────────────────────────────────────────────────
// AxACEBullet has no first-class `pinned` field, so we store pin state in
// `bullet.tags`.  Add / remove a "pinned" tag to toggle.  The renderer
// reads tags to decide sort order and badge display.

const PIN_TAG = 'pinned';

// ── Helpers ───────────────────────────────────────────────────────────

function loadOrSeed(agentId: string): AxPlaybookSnapshot {
  const existing = loadPlaybookSnapshot(agentId);
  if (existing) return existing;
  const playbook = seedPlaybook(agentId);
  const snap: AxPlaybookSnapshot = {
    playbook,
    artifact: { playbook, feedback: [], history: [] },
  };
  savePlaybookSnapshot(agentId, snap);
  return snap;
}

function recomputeStats(playbook: AxACEPlaybook, now: string): void {
  let totalContent = '';
  let helpful = 0;
  let harmful = 0;
  let count = 0;
  for (const bullets of Object.values(playbook.sections)) {
    for (const b of bullets) {
      count++;
      helpful += b.helpfulCount;
      harmful += b.harmfulCount;
      totalContent += b.content + ' ';
    }
  }
  playbook.stats.bulletCount = count;
  playbook.stats.helpfulCount = helpful;
  playbook.stats.harmfulCount = harmful;
  playbook.stats.tokenEstimate = estimateTokens(totalContent);
  playbook.updatedAt = now;
}

function flush(agentId: string, snap: AxPlaybookSnapshot): void {
  savePlaybookSnapshot(agentId, snap);
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Add a bullet to the given section.  If the agent has no snapshot yet,
 * seed one first.
 *
 * @returns the newly-created bullet
 */
export function addBullet(
  agentId: string,
  section: string,
  content: string,
): AxACEBullet {
  const snap = loadOrSeed(agentId);
  const now = new Date().toISOString();
  const bullet: AxACEBullet = {
    id: contentId(section, content),
    section,
    content,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: now,
    updatedAt: now,
    tags: [],
  };

  const bullets = snap.playbook.sections[section] ?? [];
  bullets.push(bullet);
  snap.playbook.sections[section] = bullets;
  recomputeStats(snap.playbook, now);
  flush(agentId, snap);
  return bullet;
}

/**
 * Edit a bullet's content by ID.  The id field stays stable.
 */
export function editBullet(
  agentId: string,
  bulletId: string,
  content: string,
): void {
  const snap = loadPlaybookSnapshot(agentId);
  if (!snap) throw new Error(`No playbook for ${agentId}`);

  const now = new Date().toISOString();
  let found = false;
  for (const bullets of Object.values(snap.playbook.sections)) {
    const b = bullets.find((b) => b.id === bulletId);
    if (b) {
      b.content = content;
      b.updatedAt = now;
      found = true;
      break;
    }
  }
  if (!found) throw new Error(`Bullet ${bulletId} not found`);
  recomputeStats(snap.playbook, now);
  flush(agentId, snap);
}

/**
 * Delete a bullet by ID.
 */
export function deleteBullet(
  agentId: string,
  bulletId: string,
): void {
  const snap = loadPlaybookSnapshot(agentId);
  if (!snap) throw new Error(`No playbook for ${agentId}`);

  const now = new Date().toISOString();
  let found = false;
  for (const bullets of Object.values(snap.playbook.sections)) {
    const idx = bullets.findIndex((b) => b.id === bulletId);
    if (idx !== -1) {
      bullets.splice(idx, 1);
      found = true;
      break;
    }
  }
  if (!found) throw new Error(`Bullet ${bulletId} not found`);
  recomputeStats(snap.playbook, now);
  flush(agentId, snap);
}

/**
 * Toggle a pin on/off for a bullet.  Pin state lives in `bullet.tags`
 * because AxACEBullet has no first-class `pinned` field.
 *
 * @returns the new pinned state (true = pinned, false = unpinned)
 */
export function pinBullet(
  agentId: string,
  bulletId: string,
  pinned: boolean,
): boolean {
  const snap = loadPlaybookSnapshot(agentId);
  if (!snap) throw new Error(`No playbook for ${agentId}`);

  let found = false;
  for (const bullets of Object.values(snap.playbook.sections)) {
    const b = bullets.find((b) => b.id === bulletId);
    if (b) {
      b.tags = b.tags ?? [];
      if (pinned && !b.tags.includes(PIN_TAG)) {
        b.tags.push(PIN_TAG);
      } else if (!pinned) {
        b.tags = b.tags.filter((t) => t !== PIN_TAG);
      }
      b.updatedAt = new Date().toISOString();
      found = true;
      break;
    }
  }
  if (!found) throw new Error(`Bullet ${bulletId} not found`);
  flush(agentId, snap);
  return pinned;
}
