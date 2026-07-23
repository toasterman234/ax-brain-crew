import { getLogger } from '../observability/logger.js';
import {
  enqueueResearch,
  getResearchJob,
  type ResearchJob,
} from '../persistence/research-jobs.js';

// research.enqueue / research.status — the crew's async-research trigger
// (crew-web-tool-design.md §2). enqueue does a ~0ms local sqlite insert and
// returns a jobId so the live turn never eats the 60–120s research cost; a
// separate `crew worker` process runs the actual research. status reads a row
// back. Both are gated to Seeker in registry.yaml.
//
// No external dependency, so there is no "not configured" case — but enqueue
// still honors crew DRY_RUN: in a dry run it reports the job WITHOUT writing a
// queue row, matching memory.save / vault.write semantics.

export interface EnqueueResult {
  operation: 'queued' | 'dry-run';
  jobId?: string;
  question: string;
  status: string;
}

export function researchEnqueue(question: string, dryRun: boolean, requestedBy?: string): EnqueueResult {
  const logger = getLogger();
  const q = (question ?? '').trim();

  if (dryRun) {
    logger.info({ question: q.slice(0, 80) }, 'research.enqueue dry-run (not queued)');
    return { operation: 'dry-run', question: q, status: 'not-queued (dry run)' };
  }

  const jobId = enqueueResearch(q, requestedBy);
  return { operation: 'queued', jobId, question: q, status: 'queued' };
}

export interface StatusResult {
  found: boolean;
  job?: Pick<
    ResearchJob,
    'id' | 'status' | 'question' | 'result_path' | 'summary' | 'error' | 'created_at' | 'completed_at'
  >;
}

export function researchStatus(jobId: string): StatusResult {
  const job = getResearchJob((jobId ?? '').trim());
  if (!job) return { found: false };
  return {
    found: true,
    job: {
      id: job.id,
      status: job.status,
      question: job.question,
      result_path: job.result_path,
      summary: job.summary,
      error: job.error,
      created_at: job.created_at,
      completed_at: job.completed_at,
    },
  };
}
