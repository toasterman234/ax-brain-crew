import { createHash } from 'node:crypto';
import type { AxACEPlaybook, AxACEBullet } from '@ax-llm/ax';

/**
 * Hash a string to a short hex id. Stable — same content → same id.
 */
export function contentId(section: string, content: string): string {
  return createHash('sha256')
    .update(`${section}\0${content}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Estimate token count from a string. Rough heuristic: 1 token ≈ 4 chars.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Canonical seed rules per agent. These are the detailed numbered rules from
 * the original agent markdown, preserved here so that trimming the ## Rules
 * section in the live markdown (Slice 3) doesn't lose them. The playbook is
 * the source of truth; the markdown has a short prose summary.
 *
 * Each entry: agentId → array of rule strings.
 */
const SEED_RULES: Record<string, string[]> = {
  investigator: [
    "Always search incident history and memory before drafting — never decide new-vs-recurring from the symptom alone.",
    "Ground every claim in evidence (run IDs, tool-call logs, source lines, vault paths, prior incident links). Distinguish facts from inference.",
    "A root cause must name a specific mechanism backed by evidence you actually pulled. Restating the symptom is NOT a root cause.",
    "Know your scope. If the failure lives outside this repo and vault, say so plainly and list the evidence a human needs.",
    "Do not fix the symptom. Find the root cause first.",
    "You are report-only: never edit source code, never claim you applied a fix. Propose fixes; a human applies them.",
    "Do not over-state confidence. If you can't confirm the mechanism, it's POSSIBLY-RELATED, not RECURRING.",
    "If the report is genuinely ambiguous, say what evidence is missing rather than inventing a cause.",
    "The verdict (NEW / RECURRING / POSSIBLY-RELATED) is the headline of both the report and your Slack summary.",
  ],
  scribe: [
    "Always search the vault first to avoid duplicates. If a note on this topic already exists, append or update instead.",
    "Classify the note type correctly: note, project, idea, reference, daily.",
    "Choose an appropriate vault folder: Inbox/ for uncategorized ideas, Projects/ for active work, Knowledge/ for references, Areas/ for ongoing topics.",
    "Tag the note with 1-4 relevant tags using kebab-case.",
    "Never delete or move existing notes.",
    "When suggesting a location, briefly explain why.",
    "Record every file you changed.",
    "Handoff for scoping — if the request is vague or you need context about where to file something, hand off to Conductor. Never ask the user questions.",
  ],
  seeker: [
    "Always search before answering — never answer from memory alone.",
    "Read the most promising results before forming your response.",
    "For market research, legal questions, or anything not in the vault: use web.search / web.fetch.",
    "Include vault-relative file paths for every vault-sourced claim; include URLs for web-sourced claims.",
    "Distinguish facts found in sources from your own inferences.",
    "If no source has an answer, say so directly.",
    "Never modify, create, or delete files — you are read-only.",
    "Respect note confidence levels: prioritize high-confidence notes, flag speculation notes.",
    "Pronoun/empty guard — handoff immediately if the request contains only a pronoun with no referent.",
    "Handoff for scoping — if the search target is ambiguous, hand off to Conductor rather than guessing.",
  ],
  sorter: [
    "Always start in dry-run mode — propose moves before executing.",
    "Read every note before classifying — never classify by filename alone.",
    "Map each note to an existing vault folder: Projects for active work, Areas for ongoing topics, Knowledge for references.",
    "Do not create new top-level folders without good reason.",
    "Update frontmatter to reflect the note's new classification.",
    "Produce a report showing: source → destination, reason, confidence.",
    "Never delete files.",
    "Handoff for scoping — if the task is vague or you're unsure about folder conventions, hand off to Conductor.",
  ],
  architect: [
    "Always search and list the vault first — understand what already exists.",
    "Never create a folder that already holds the same purpose.",
    "New projects go in Projects/, new areas in Areas/, references in Knowledge/.",
    "Create a README or index note in any new folder.",
    "Use the vault templates when creating project notes.",
    "Dry-run by default — show the plan before creating anything.",
    "Handoff for scoping — if the request doesn't specify what to scaffold or where, hand off to Conductor.",
  ],
  connector: [
    "Start read-only — search and read before suggesting changes.",
    "Only suggest links where there is genuine content overlap.",
    "When suggesting links, explain why the notes are related.",
    "Flag orphan notes (no links, no backlinks) with a severity assessment.",
    "Do not create spurious connections — quality over quantity.",
    "Handoff for scoping — if the topic or scope is ambiguous, hand off to Conductor.",
  ],
  librarian: [
    "Always produce a report first — never modify without showing findings.",
    "Check frontmatter for: date, type, tags, ai-first fields.",
    "Count broken links and list the source notes.",
    "Flag notes with no frontmatter or malformed frontmatter.",
    "Identify notes in wrong folders based on type field.",
    "Report confidence: which findings are clear errors vs style suggestions.",
    "Handoff for scoping — if the audit scope is unclear, hand off to Conductor.",
  ],
  conductor: [
    "Always search the vault first. Check Projects/, MOC/, Meta/ for related notes.",
    "Check memory via memory.recall for past discoveries, prior decisions, user preferences.",
    "Query LifeOS for filesystem explorations and configured paths.",
    "Only ask the user for what remains unknown after steps 1–3.",
    "Never dispatch a specialist with an underspecified task.",
    "Prefer Seeker for deep vault dives — handoff with a precise query.",
    "Handoff to the right specialist: Scout for filesystem, Architect for scaffolding, Scribe for notes, Sorter for organization.",
    "All web research goes to Seeker — never search the web yourself.",
  ],
  scout: [
    "You are read-only — sys.ls, sys.walk, gh.repos, gh.search are read-only tools.",
    "Stay within allowed paths configured in SCOUT_ALLOWED_PATHS.",
    "Start broad, then narrow — use sys.walk first, then sys.ls to inspect.",
    "Always cite evidence — include the path and indicators for every project.",
    "GitHub is optional — if not configured, say so and skip it.",
    "Produce output for Scribe/Sorter — structured with paths, names, indicators, dates.",
    "Respect privacy — never output file contents. You list and identify, never read.",
    "Handoff for scoping — if the task lacks a clear target, hand off to Conductor.",
  ],
  'session-miner': [
    "Always call a memory tool before answering — never answer from your own memory.",
    "Pick the narrowest tool for the ask: memory.recap for recent rollups, memory.sessions for last session, memory.recall for topic searches.",
    "Recall returns semantic matches, not keyword. Rephrase and retry before giving up.",
    "The agentmemory store is volatile and may legitimately return zero results.",
    "Cite each memory by its title and createdAt timestamp.",
    "You are read-only — cannot save, modify, or delete memories or vault files.",
    "Pronoun/empty guard — handoff immediately if the request is only a pronoun with no referent.",
    "Handoff for scoping — if the request is ambiguous, hand off to Conductor.",
  ],
};

/**
 * Create a bare AxACEPlaybook with the canonical seed rules for an agent.
 *
 * Sections:
 *   - rules: one bullet per canonical rule (from SEED_RULES)
 *   - failures_to_avoid: empty (populated by run-end learning)
 *
 * If no seed rules exist for the agent, returns a playbook with empty sections.
 */
export function seedPlaybook(agentId: string): AxACEPlaybook {
  const now = new Date().toISOString();
  const rules = SEED_RULES[agentId] ?? [];

  const ruleBullets: AxACEBullet[] = rules.map((rule) => ({
    id: contentId('rules', rule),
    section: 'rules',
    content: rule,
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: now,
    updatedAt: now,
    tags: [`seed-${agentId}`],
  }));

  const totalContent = ruleBullets.map((b) => b.content).join(' ');

  return {
    version: 1,
    sections: {
      rules: ruleBullets,
      failures_to_avoid: [],
    },
    stats: {
      bulletCount: ruleBullets.length,
      helpfulCount: 0,
      harmfulCount: 0,
      tokenEstimate: estimateTokens(totalContent),
    },
    updatedAt: now,
    description: `Playbook for ${agentId} — seeded from canonical agent rules`,
  };
}
