import { ax } from '@ax-llm/ax';
import { createModelClient } from '../ai/clients.js';
import { getLogger } from '../observability/logger.js';
import { initializeRuntime } from '../runtime/init.js';
import {
  claimNextJob,
  completeJob,
  failJob,
  reclaimStaleJobs,
  type ResearchJob,
} from '../persistence/research-jobs.js';
import {
  webSearch,
  webFetch,
  isWebConfigured,
  summarizeForContext,
} from '../tools/index.js';
import { vaultWrite } from '../tools/vault-write.js';
import { executeAgent } from '../runtime/executor.js';
import { getAgent } from '../registry/registry.js';
import type { ValidatedAgent } from '../registry/loader.js';

// `crew worker` — the long-lived background research process
// (crew-web-tool-design.md §2–3). It polls research_jobs, and for each claimed
// job runs the research loop OFF the live chat turn on its own step budget:
//
//   search -> fetch <=5 pages -> summarize-then-store each -> reason/synthesize
//   -> hand to a Scribe pass that formats a Projects/research-<slug>-<date>.md
//
// ANTI-HALLUCINATION GUARD (§5, the catastrophic risk): the Sources list in the
// note is built ONLY from URLs the worker actually fetched successfully — never
// from anything the model emits. The worker owns that list; the model only sees
// the fetched text, never authors the citations.

const POLL_INTERVAL_MS = 3000;
const MAX_FETCHES_PER_JOB = 5;

interface FetchedPage {
  url: string;
  title: string;
  gist: string; // summarize-then-store output (3–5 lines)
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'topic'
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run the research loop for one job. Returns the synthesized findings text plus
 * the worker-owned list of URLs that were actually fetched (for Sources).
 */
async function runResearch(
  job: ResearchJob,
): Promise<{ synthesis: string; pages: FetchedPage[] }> {
  const logger = getLogger();

  // 1. SEARCH — one Brave query for the question.
  const searchResults = await webSearch(job.question, 8);
  logger.info({ jobId: job.id, results: searchResults.length }, 'worker: search done');

  // 2. FETCH — up to MAX_FETCHES_PER_JOB pages, skip-and-continue on failure.
  const pages: FetchedPage[] = [];
  for (const r of searchResults) {
    if (pages.length >= MAX_FETCHES_PER_JOB) break;
    if (!r.url) continue;
    const fetched = await webFetch(r.url);
    if (!fetched.ok || !fetched.text) {
      logger.warn({ jobId: job.id, url: r.url, error: fetched.error }, 'worker: fetch skipped');
      continue;
    }
    // 3. SUMMARIZE-THEN-STORE — condense before it re-enters working context.
    const gist = await summarizeForContext(fetched.text, job.question);
    pages.push({ url: r.url, title: r.title || r.url, gist });
  }

  if (pages.length === 0) {
    throw new Error('No pages could be fetched for this question (all fetches failed).');
  }

  // 4. REASON / SYNTHESIZE — a single smart-tier forward over the gists only.
  // The model never sees or produces URLs here; it reasons over condensed text.
  const evidenceBlock = pages
    .map((p, i) => `[Source ${i + 1}] ${p.title}\n${p.gist}`)
    .join('\n\n');

  const llm = createModelClient('smart');
  const synthesizer = ax(
    `question:string, evidence:string -> answer:string "A grounded, well-structured synthesis answering the question using ONLY the evidence. Cite sources inline as [Source N]. Do not invent facts or URLs."`,
  );
  const result = await synthesizer.forward(llm, {
    question: job.question,
    evidence: evidenceBlock,
  });
  const synthesis = String(result?.answer ?? '').trim() || evidenceBlock;

  return { synthesis, pages };
}

/**
 * Hand the synthesized findings to a Scribe pass to produce a clean note BODY,
 * then the worker assembles the final file — appending the worker-owned Sources
 * list — and writes it. Scribe formats prose; the worker owns the citations.
 */
async function writeResultNote(
  job: ResearchJob,
  synthesis: string,
  pages: FetchedPage[],
): Promise<{ path: string; summary: string }> {
  const slug = slugify(job.question);
  const date = today();
  const notePath = `Projects/research-${slug}-${date}.md`;

  // Scribe pass: format the synthesis into clean markdown prose (no frontmatter,
  // no Sources — the worker owns those). Bounded to a short turn.
  const scribe = getAgent('scribe') as ValidatedAgent | undefined;
  let body = synthesis;
  if (scribe) {
    const prevBudget = process.env.CREW_MAX_STEPS;
    process.env.CREW_MAX_STEPS = '4'; // Scribe write-back is a short turn again.
    try {
      const scribeInput = [
        `Format the following research findings into a clear, well-structured Markdown note body.`,
        `Do NOT add YAML frontmatter and do NOT add a Sources section — those are added separately.`,
        `Keep the inline [Source N] citations exactly as they appear. Do not invent any facts or URLs.`,
        ``,
        `## Research question`,
        job.question,
        ``,
        `## Findings`,
        synthesis,
      ].join('\n');
      const exec = await executeAgent({
        agent: scribe,
        input: scribeInput,
        dryRun: false, // the worker's own writes are real regardless of chat DRY_RUN
      });
      if (exec.success && exec.result.response.trim().length > 0) {
        body = exec.result.response.trim();
      }
    } finally {
      if (prevBudget === undefined) delete process.env.CREW_MAX_STEPS;
      else process.env.CREW_MAX_STEPS = prevBudget;
    }
  }

  // Worker-owned Sources — built ONLY from URLs actually fetched.
  const sources = pages
    .map((p, i) => `${i + 1}. [${p.title}](${p.url})`)
    .join('\n');

  const frontmatter = [
    '---',
    `type: research`,
    `status: draft`,
    `ai-first: true`,
    `date: ${date}`,
    `job_id: ${job.id}`,
    `source_urls:`,
    ...pages.map((p) => `  - ${p.url}`),
    '---',
    '',
  ].join('\n');

  const content = `${frontmatter}# Research: ${job.question}

*Researched ${date} by the crew worker. ${pages.length} source(s) fetched.*

${body}

## Sources

${sources}
`;

  vaultWrite({ path: notePath, content, overwrite: true, dryRun: false });

  const summary = synthesis.replace(/\s+/g, ' ').slice(0, 400);
  return { path: notePath, summary };
}

async function processJob(job: ResearchJob): Promise<void> {
  const logger = getLogger();
  logger.info({ jobId: job.id, question: job.question }, 'worker: processing job');

  // Background step budget — generous, off the live-turn cap (design §3).
  const prevBudget = process.env.CREW_MAX_STEPS;
  process.env.CREW_MAX_STEPS = process.env.CREW_WORKER_MAX_STEPS ?? '12';

  try {
    const { synthesis, pages } = await runResearch(job);
    const { path, summary } = await writeResultNote(job, synthesis, pages);
    completeJob(job.id, path, summary);
    logger.info({ jobId: job.id, path }, 'worker: job done');
  } catch (err) {
    failJob(job.id, String(err));
    logger.error({ jobId: job.id, err: String(err) }, 'worker: job failed');
  } finally {
    if (prevBudget === undefined) delete process.env.CREW_MAX_STEPS;
    else process.env.CREW_MAX_STEPS = prevBudget;
  }
}

export async function runWorker(options: { once?: boolean } = {}): Promise<void> {
  const logger = getLogger();
  initializeRuntime();

  // Reclaim any job a crashed previous worker left 'running' (design §5).
  reclaimStaleJobs();

  if (!isWebConfigured()) {
    logger.warn(
      'BRAVE_SEARCH_API_KEY is not set — the worker will poll and idle, but any claimed job will fail at the search step. Set the key to run real research.',
    );
  }

  logger.info({ once: Boolean(options.once) }, 'crew worker started; polling research_jobs');

  let idleLogged = false;
  while (true) {
    const job = claimNextJob();
    if (job) {
      idleLogged = false;
      await processJob(job);
      continue;
    }

    if (options.once) {
      logger.info('worker: no queued jobs (--once); exiting');
      return;
    }

    if (!idleLogged) {
      logger.info('worker: queue empty; waiting for jobs');
      idleLogged = true;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
