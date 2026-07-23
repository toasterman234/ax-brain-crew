import { fn, f } from '@ax-llm/ax';
import { vaultRead } from '../tools/vault-read.js';
import { vaultWrite } from '../tools/vault-write.js';
import { vaultAppend } from '../tools/vault-append.js';
import { vaultSearch } from '../tools/vault-search.js';
import { vaultList } from '../tools/vault-list.js';
import { vaultMove } from '../tools/vault-move.js';
import {
  vaultReadFrontmatter,
  vaultUpdateFrontmatter,
} from '../tools/vault-frontmatter.js';
import {
  externalRead,
  externalList,
  externalSearch,
  isExternalVaultConfigured,
} from '../tools/external-vault.js';
import { sysLs, sysWalk, isPathAllowed } from '../tools/fs-explore.js';
import {
  ghListRepos,
  ghSearchCode,
  isGithubConfigured,
} from '../tools/github-explore.js';
import {
  memoryRecall,
  memorySave,
  memorySessions,
  memoryRecap,
  memoryTimeline,
  isMemoryConfigured,
} from '../tools/memory-explore.js';
import { lifeQuery, isLifeosConfigured } from '../tools/lifeos-explore.js';
import {
  webSearch,
  webFetch,
  isWebConfigured,
  WEB_NOT_CONFIGURED,
} from '../tools/web-explore.js';
import {
  researchEnqueue,
  researchStatus,
} from '../tools/research-explore.js';
import { checkPhaseGate } from '../tools/phase-gate.js';
import { listRuns, getRun } from '../tools/crew-runs.js';
import { codeRead } from '../tools/code-read.js';

type BuildFn = (dryRun: boolean) => any;

const toolBuilders: Record<string, BuildFn> = {
  'vault.read': () =>
    fn('vaultRead')
      .description('Read a note from the vault')
      .arg('path', f.string('Vault-relative path'))
      .returns(f.string('Note content as Markdown'))
      .handler(async ({ path }: { path: string }) =>
        JSON.stringify(vaultRead({ path })),
      )
      .build(),

  'vault.search': () =>
    fn('vaultSearch')
      .description('Search vault for a query')
      .arg('query', f.string('Search query'))
      .arg('directory', f.string('Optional directory').optional())
      .arg('limit', f.number('Max results').optional())
      .returns(f.string('JSON of results'))
      .handler(
        async (args: { query: string; directory?: string; limit?: number }) =>
          JSON.stringify(vaultSearch(args)),
      )
      .build(),

  'vault.list': () =>
    fn('vaultList')
      .description('List files in a vault directory')
      .arg('directory', f.string('Directory path').optional())
      .returns(f.string('JSON of items'))
      .handler(async ({ directory }: { directory?: string }) =>
        JSON.stringify(vaultList({ directory })),
      )
      .build(),

  'vault.write': (dryRun: boolean) =>
    fn('vaultWrite')
      .description(
        dryRun
          ? '[DRY RUN] Simulate creating a note'
          : 'Create or overwrite a note',
      )
      .arg('path', f.string('Vault-relative path'))
      .arg('content', f.string('Markdown content'))
      .arg('overwrite', f.boolean('Allow overwrite').optional())
      .returns(f.string('JSON result'))
      .handler(
        async (args: { path: string; content: string; overwrite?: boolean }) =>
          JSON.stringify(vaultWrite({ ...args, dryRun })),
      )
      .build(),

  'vault.append': (dryRun: boolean) =>
    fn('vaultAppend')
      .description(
        dryRun ? '[DRY RUN] Simulate appending' : 'Append to a note',
      )
      .arg('path', f.string('Vault-relative path'))
      .arg('content', f.string('Content to append'))
      .returns(f.string('JSON result'))
      .handler(async (args: { path: string; content: string }) =>
        JSON.stringify(vaultAppend({ ...args, dryRun })),
      )
      .build(),

  'vault.move': (dryRun: boolean) =>
    fn('vaultMove')
      .description(
        dryRun ? '[DRY RUN] Simulate moving a file' : 'Move or rename a file',
      )
      .arg('source', f.string('Current path'))
      .arg('destination', f.string('New path'))
      .returns(f.string('JSON result'))
      .handler(
        async (args: { source: string; destination: string }) =>
          JSON.stringify(vaultMove({ ...args, dryRun })),
      )
      .build(),

  'vault.readFrontmatter': () =>
    fn('vaultReadFrontmatter')
      .description('Read YAML frontmatter')
      .arg('path', f.string('Vault-relative path'))
      .returns(f.string('JSON with frontmatter'))
      .handler(async ({ path }: { path: string }) =>
        JSON.stringify(vaultReadFrontmatter({ path })),
      )
      .build(),

  'vault.updateFrontmatter': (dryRun: boolean) =>
    fn('vaultUpdateFrontmatter')
      .description(
        dryRun
          ? '[DRY RUN] Simulate updating frontmatter'
          : 'Update frontmatter fields',
      )
      .arg('path', f.string('Vault-relative path'))
      .arg('fields', f.string('JSON fields to update'))
      .returns(f.string('JSON result'))
      .handler(
        async (args: { path: string; fields: string }) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(args.fields);
          } catch {
            return JSON.stringify({
              path: args.path,
              operation: 'error',
              reason: 'Invalid JSON for fields',
            });
          }
          return JSON.stringify(
            vaultUpdateFrontmatter({ path: args.path, fields: parsed, dryRun }),
          );
        },
      )
      .build(),

  'ext.read': () =>
    fn('externalVaultRead')
      .description('Read a note from the external reference vault (read-only). Use only for assessment/comparison.')
      .arg('path', f.string('Path relative to external vault root'))
      .returns(f.string('Note content or null if external vault not configured'))
      .handler(async ({ path }: { path: string }) => {
        if (!isExternalVaultConfigured()) return 'External vault not configured. Set EXTERNAL_VAULT_PATH in .env';
        const result = externalRead(path);
        return result ? JSON.stringify(result) : 'File not found';
      })
      .build(),

  'ext.list': () =>
    fn('externalVaultList')
      .description('List contents of the external reference vault (read-only). Use for surveying what exists before recommending migrations.')
      .arg('directory', f.string('Directory path relative to external vault').optional())
      .returns(f.string('JSON of directory listing'))
      .handler(async ({ directory }: { directory?: string }) => {
        if (!isExternalVaultConfigured()) return 'External vault not configured.';
        const result = externalList(directory);
        return result ? JSON.stringify(result) : 'Invalid path';
      })
      .build(),

  'ext.search': () =>
    fn('externalVaultSearch')
      .description('Search the external reference vault for content matching a query (read-only).')
      .arg('query', f.string('Search query'))
      .arg('limit', f.number('Max results').optional())
      .returns(f.string('JSON of search results'))
      .handler(async (args: { query: string; limit?: number }) => {
        if (!isExternalVaultConfigured()) return 'External vault not configured.';
        const result = externalSearch(args.query, args.limit);
        return result ? JSON.stringify(result) : 'Search failed';
      })
      .build(),

  'sys.ls': () =>
    fn('systemLs')
      .description('List a directory on the local filesystem. Only works within allowed paths (configured in .env).')
      .arg('path', f.string('Absolute or relative path to list'))
      .returns(f.string('JSON of directory listing with project indicators'))
      .handler(async ({ path }: { path: string }) => {
        if (!isPathAllowed(path)) return JSON.stringify({
          error: `Path "${path}" is not in Scout allowed paths. Configure SCOUT_ALLOWED_PATHS in .env`,
          path,
        });
        return JSON.stringify(sysLs({ path }));
      })
      .build(),

  'sys.walk': () =>
    fn('systemWalk')
      .description('Recursively walk a directory tree on the local filesystem, identifying project directories. Only works within allowed paths.')
      .arg('path', f.string('Absolute or relative path to walk'))
      .arg('maxDepth', f.number('Maximum recursion depth (1-5, default 3)').optional())
      .returns(f.string('JSON of project directories found'))
      .handler(async ({ path, maxDepth }: { path: string; maxDepth?: number }) => {
        if (!isPathAllowed(path)) return JSON.stringify({
          error: `Path "${path}" is not in Scout allowed paths.`,
          path,
        });
        return JSON.stringify(sysWalk({ path, maxDepth }));
      })
      .build(),

  'gh.repos': () =>
    fn('githubRepos')
      .description('List GitHub repositories for the configured user (sorted by recently updated).')
      .returns(f.string('JSON of repositories'))
      .handler(async () => {
        if (!isGithubConfigured()) return 'GitHub not configured. Set GITHUB_TOKEN and GITHUB_USER in .env';
        const repos = await ghListRepos();
        return JSON.stringify(repos);
      })
      .build(),

  'gh.search': () =>
    fn('githubSearch')
      .description('Search code across the user\'s GitHub repositories.')
      .arg('query', f.string('Search query'))
      .arg('limit', f.number('Max results (default 10)').optional())
      .returns(f.string('JSON of search results'))
      .handler(async ({ query, limit }: { query: string; limit?: number }) => {
        if (!isGithubConfigured()) return 'GitHub not configured.';
        const result = await ghSearchCode(query, limit);
        return JSON.stringify(result);
      })
      .build(),

  'memory.recall': () =>
    fn('memoryRecall')
      .description('Recall past observations/learnings from agentmemory. The store is volatile, so this may return few or no results.')
      .arg('query', f.string('What to recall'))
      .arg('limit', f.number('Max results (default 5)').optional())
      .returns(f.string('JSON list of recalled memories (possibly empty)'))
      .handler(async ({ query, limit }: { query: string; limit?: number }) => {
        if (!isMemoryConfigured()) return 'Memory not configured. Set AGENTMEMORY_BASE_URL in .env';
        const memories = await memoryRecall(query, limit);
        return JSON.stringify(memories);
      })
      .build(),

  'memory.sessions': () =>
    fn('memorySessions')
      .description('List recent agentmemory sessions (id, project, startedAt, status, observation count). The store is volatile, so this may return few or no results.')
      .arg('limit', f.number('Max sessions (default 20)').optional())
      .returns(f.string('JSON list of recent sessions (possibly empty)'))
      .handler(async ({ limit }: { limit?: number }) => {
        if (!isMemoryConfigured()) return 'Memory not configured. Set AGENTMEMORY_BASE_URL in .env';
        const sessions = await memorySessions(limit);
        return JSON.stringify(sessions);
      })
      .build(),

  'memory.recap': () =>
    fn('memoryRecap')
      .description('Recap recent agentmemory sessions as a newest-first rollup (built on the sessions list). Use for "recap yesterday / last session / recently". The store is volatile, so this may return few or no results.')
      .arg('limit', f.number('Max recent sessions to roll up (default 10)').optional())
      .returns(f.string('JSON recap { sessionCount, sessions } (possibly empty)'))
      .handler(async ({ limit }: { limit?: number }) => {
        if (!isMemoryConfigured()) return 'Memory not configured. Set AGENTMEMORY_BASE_URL in .env';
        const recap = await memoryRecap(limit);
        return JSON.stringify(recap);
      })
      .build(),

  'memory.timeline': () =>
    fn('memoryTimeline')
      .description('Get chronological observations around an anchor point. The anchor must be an ISO date or a topic keyword — NOT a session/memory id, those are not accepted and return no matches. Use to reconstruct what happened around a specific moment. The store is volatile, so this may return few or no results.')
      .arg('anchor', f.string('Anchor point: ISO date or topic keyword (not a session/memory id)'))
      .arg('before', f.number('Observations before the anchor (default 5)').optional())
      .arg('after', f.number('Observations after the anchor (default 5)').optional())
      .returns(f.string('JSON list of observations around the anchor (possibly empty)'))
      .handler(async ({ anchor, before, after }: { anchor: string; before?: number; after?: number }) => {
        if (!isMemoryConfigured()) return 'Memory not configured. Set AGENTMEMORY_BASE_URL in .env';
        const timeline = await memoryTimeline(anchor, before, after);
        return JSON.stringify(timeline);
      })
      .build(),

  'memory.save': (dryRun: boolean) =>
    fn('memorySave')
      .description(
        dryRun
          ? '[DRY RUN] Simulate saving a learning to agentmemory'
          : 'Save a learning/observation to agentmemory for future recall',
      )
      .arg('content', f.string('The learning to save'))
      .returns(f.string('JSON result'))
      .handler(async ({ content }: { content: string }) => {
        if (!isMemoryConfigured()) return 'Memory not configured. Set AGENTMEMORY_BASE_URL in .env';
        const result = await memorySave(content, dryRun);
        return JSON.stringify(result);
      })
      .build(),

  'life.query': () =>
    fn('lifeQuery')
      .description('Semantic search over Ben\'s Life OS data (what he owns/spends/watches/knows). Read-only. Reaches real financial/health data — use sparingly.')
      .arg('question', f.string('The question to search Life OS for'))
      .arg('topK', f.number('Max results (default 5)').optional())
      .returns(f.string('JSON list of semantic-search results'))
      .handler(async ({ question, topK }: { question: string; topK?: number }) => {
        if (!isLifeosConfigured()) return 'Life OS not configured. Set LIFEOS_BASE_URL in .env';
        const results = await lifeQuery(question, topK);
        return JSON.stringify(results);
      })
      .build(),

  'web.search': () =>
    fn('webSearch')
      .description('Search the web via Serper (Google Search). Returns a clean list of {title, url, description}. Reason over the results, then web.fetch only the URLs worth reading.')
      .arg('query', f.string('Search query'))
      .arg('limit', f.number('Max results (default 8)').optional())
      .returns(f.string('JSON list of search results'))
      .handler(async ({ query, limit }: { query: string; limit?: number }) => {
        if (!isWebConfigured()) return WEB_NOT_CONFIGURED;
        const results = await webSearch(query, limit);
        return JSON.stringify(results);
      })
      .build(),

  'web.fetch': () =>
    fn('webFetch')
      .description('Fetch a single URL and return its readable body text. Keyless. Blocks private/loopback addresses and non-http(s) schemes. Never invent a URL — only fetch ones from a search result or the user.')
      .arg('url', f.string('The http(s) URL to fetch'))
      .returns(f.string('JSON { url, ok, status?, text?, error? }'))
      .handler(async ({ url }: { url: string }) => {
        const result = await webFetch(url);
        return JSON.stringify(result);
      })
      .build(),

  'research.enqueue': (dryRun: boolean) =>
    fn('researchEnqueue')
      .description(
        dryRun
          ? '[DRY RUN] Simulate queuing a background web-research job'
          : 'Queue a background web-research job for a question you cannot answer from the vault. Returns a jobId immediately; findings are written to the vault when done. Do NOT answer such questions from model memory.',
      )
      .arg('question', f.string('The research question to investigate'))
      .returns(f.string('JSON { operation, jobId?, question, status }'))
      .handler(async ({ question }: { question: string }) =>
        JSON.stringify(researchEnqueue(question, dryRun)),
      )
      .build(),

  'research.status': () =>
    fn('researchStatus')
      .description('Read back the status and result of a queued research job by its id.')
      .arg('jobId', f.string('The job id returned by research.enqueue'))
      .returns(f.string('JSON { found, job? }'))
      .handler(async ({ jobId }: { jobId: string }) =>
        JSON.stringify(researchStatus(jobId)),
      )
      .build(),

  // Read-only diagnostic tools for the Investigator: query the crew's own run
  // history (crew.sqlite) and read its source, so it can trace a failure to a
  // real mechanism instead of speculating. None of these write anything.
  'crew.listRuns': () =>
    fn('crewListRuns')
      .description(
        'List recent crew runs newest-first (id, status, route, error). Filter by status (e.g. "failed") or agent to locate a failure. Read-only.',
      )
      .arg('status', f.string('Filter by run status, e.g. "failed" or "completed"').optional())
      .arg('agent', f.string('Filter by the agent/route id that ran, e.g. "seeker"').optional())
      .arg('limit', f.number('Max rows (1-100, default 20)').optional())
      .returns(f.string('JSON { runs: [...] }'))
      .handler(async (args: { status?: string; agent?: string; limit?: number }) =>
        JSON.stringify(listRuns(args)),
      )
      .build(),

  'crew.getRun': () =>
    fn('crewGetRun')
      .description(
        'Full trace for one crew run: the run row, every step, each step\'s tool calls (inputs/outputs), and files changed. runId may be a unique prefix. This is the primary evidence for tracing a failure. Read-only.',
      )
      .arg('runId', f.string('Full run id or a unique prefix'))
      .returns(f.string('JSON run detail, or { error } if not found/ambiguous'))
      .handler(async ({ runId }: { runId: string }) =>
        JSON.stringify(getRun({ runId })),
      )
      .build(),

  'code.read': () =>
    fn('codeRead')
      .description(
        'Read a source file from the crew repo (repo-relative path, e.g. "src/runtime/executor.ts"). Read-only, fenced to the repo, secrets denied. Use to confirm a failure mechanism in code.',
      )
      .arg('path', f.string('Repo-relative file path'))
      .arg('maxChars', f.number('Max characters to return (500-60000, default 20000)').optional())
      .returns(f.string('JSON { path, content, size, truncated }'))
      .handler(async (args: { path: string; maxChars?: number }) =>
        JSON.stringify(codeRead(args)),
      )
      .build(),

  // The PREVENT half of the phase-gate (pm-lifecycle-enforcement). Read-only,
  // approval 0: a crew flow calls this BEFORE marking a phase done to confirm
  // the phase produced its lifecycle-template artifact. Returns the structured
  // { ok, ... } result verbatim (a refusal is data the caller surfaces to Ben,
  // never a throw). Ignores dryRun — it performs no writes.
  'pm.checkPhaseGate': () =>
    fn('checkPhaseGate')
      .description('Check that a project phase has produced its lifecycle-template artifact before it is marked done. Read-only. Returns a structured result: { ok: true, ... } when the artifact exists, or { ok: false, reason, missingArtifact, ... } as a refusal the caller surfaces (never throws for a policy failure).')
      .arg('projectId', f.string('The pm-project id OR the <Name> of the project'))
      .arg('phase', f.string('The phase to check, e.g. "scope", "plan", "build", "verify", "gather"'))
      .returns(f.string('JSON PhaseGateResult { ok, ... }'))
      .handler(async ({ projectId, phase }: { projectId: string; phase: string }) =>
        JSON.stringify(checkPhaseGate(projectId, phase)),
      )
      .build(),
};

export function buildAgentTools(
  toolNames: string[],
  dryRun: boolean,
  onToolCall?: (
    toolName: string,
    args: unknown,
  ) => ((result: unknown) => void) | void,
): any[] {
  return toolNames
    .map((name) => {
      const builder = toolBuilders[name];
      if (!builder) return null;
      const tool = builder(dryRun);
      // Tap the handler so callers can trace each tool's inputs and outputs.
      if (onToolCall && typeof tool?.func === 'function') {
        const original = tool.func.bind(tool);
        tool.func = async (args: unknown) => {
          let finish: ((result: unknown) => void) | undefined;
          try {
            const cb = onToolCall(String(tool.name), args);
            finish = typeof cb === 'function' ? cb : undefined;
          } catch {
            /* tracing must never break execution */
          }
          const result = await original(args);
          try {
            finish?.(result);
          } catch {
            /* ignore trace-finish errors */
          }
          return result;
        };
      }
      return tool;
    })
    .filter(Boolean) as any[];
}
