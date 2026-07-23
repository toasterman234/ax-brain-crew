import type { ApprovalLevel } from '../types.js';

export type ToolDefinition = {
  name: string;
  description: string;
  approvalLevel: ApprovalLevel;
  source?: { file: string; line: number; function: string; tuningTips?: string[] };
};

export { setVaultRoot, getVaultRoot, resolveVaultPath, VaultPathError } from './vault-path.js';
export { vaultRead } from './vault-read.js';
export { vaultWrite } from './vault-write.js';
export { vaultAppend } from './vault-append.js';
export { vaultSearch } from './vault-search.js';
export { vaultList } from './vault-list.js';
export { vaultMove } from './vault-move.js';
export { vaultReadFrontmatter, vaultUpdateFrontmatter } from './vault-frontmatter.js';
export { memoryRecall, memorySave, isMemoryConfigured } from './memory-explore.js';
export { lifeQuery, isLifeosConfigured } from './lifeos-explore.js';
export {
  webSearch,
  webFetch,
  isWebConfigured,
  WEB_NOT_CONFIGURED,
} from './web-explore.js';
export { researchEnqueue, researchStatus } from './research-explore.js';
export { summarizeForContext } from './summarize.js';
export {
  checkPhaseGate,
  type PhaseGateResult,
  type PhaseGateOk,
  type PhaseGateRefusal,
} from './phase-gate.js';

export const TOOL_REGISTRY: ToolDefinition[] = [
  { name: 'vault.read', description: 'Read a note from the vault', approvalLevel: 0, source: { file: 'src/tools/vault-read.ts', line: 30, function: 'vaultRead', tuningTips: ['Returns full file content. Add maxChars param for large files.'] } },
  { name: 'vault.write', description: 'Create or overwrite a note', approvalLevel: 1, source: { file: 'src/tools/vault-write.ts', line: 35, function: 'vaultWrite', tuningTips: ['Creates parent directories automatically.', 'Requires approval for existing files.'] } },
  { name: 'vault.append', description: 'Append content to an existing note', approvalLevel: 1, source: { file: 'src/tools/vault-append.ts', line: 25, function: 'vaultAppend' } },
  { name: 'vault.search', description: 'Search vault contents', approvalLevel: 0, source: { file: 'src/tools/vault-search.ts', line: 42, function: 'searchVaultFiles', tuningTips: ['Uses substring matching. Switch to FTS5 for relevance ranking.', 'Limit default is 20. Increase for broader searches.', 'Case sensitivity is on. Add caseInsensitive flag for fuzzy matching.'] } },
  { name: 'vault.list', description: 'List vault directory contents', approvalLevel: 0, source: { file: 'src/tools/vault-list.ts', line: 20, function: 'vaultList' } },
  { name: 'vault.move', description: 'Move or rename a vault file', approvalLevel: 1, source: { file: 'src/tools/vault-move.ts', line: 30, function: 'vaultMove', tuningTips: ['Creates target directories if they don\'t exist.', 'Refuses to overwrite existing files.'] } },
  { name: 'vault.readFrontmatter', description: 'Read YAML frontmatter from a note', approvalLevel: 0, source: { file: 'src/tools/vault-frontmatter.ts', line: 18, function: 'vaultReadFrontmatter' } },
  { name: 'vault.updateFrontmatter', description: 'Update frontmatter fields', approvalLevel: 1, source: { file: 'src/tools/vault-frontmatter.ts', line: 45, function: 'vaultUpdateFrontmatter' } },
  { name: 'ext.read', description: 'Read a note from an external reference vault (read-only)', approvalLevel: 0, source: { file: 'src/tools/external-vault.ts', line: 22, function: 'extRead' } },
  { name: 'ext.list', description: 'List contents of an external reference vault (read-only)', approvalLevel: 0, source: { file: 'src/tools/external-vault.ts', line: 40, function: 'extList' } },
  { name: 'ext.search', description: 'Search an external reference vault (read-only)', approvalLevel: 0, source: { file: 'src/tools/external-vault.ts', line: 58, function: 'extSearch' } },
  { name: 'sys.ls', description: 'List a directory on the local filesystem (Scout-only, path-restricted)', approvalLevel: 0, source: { file: 'src/tools/fs-explore.ts', line: 15, function: 'sysLs' } },
  { name: 'sys.walk', description: 'Walk a directory tree on the local filesystem finding project directories (Scout-only, path-restricted)', approvalLevel: 0, source: { file: 'src/tools/fs-explore.ts', line: 35, function: 'sysWalk' } },
  { name: 'gh.repos', description: 'List GitHub repositories for the configured user (Scout-only)', approvalLevel: 0, source: { file: 'src/tools/github-explore.ts', line: 20, function: 'ghRepos', tuningTips: ['Uses GITHUB_TOKEN from env. Unset = empty result.', 'Cached for 5 minutes. Bypass cache by sending ?fresh=true query param concept.'] } },
  { name: 'gh.search', description: 'Search code across GitHub repositories (Scout-only)', approvalLevel: 0, source: { file: 'src/tools/github-explore.ts', line: 50, function: 'ghSearch', tuningTips: ['Rate limited to 30 req/min. Use Exa for broader searches.', 'Scoped to owned repos. Use direct API for cross-org search.'] } },
  { name: 'memory.recall', description: 'Recall past observations/learnings from agentmemory (volatile store; may be empty)', approvalLevel: 0, source: { file: 'src/tools/memory-explore.ts', line: 12, function: 'memoryRecall', tuningTips: ['Queries the agentmemory MCP server at localhost:3111.', 'Results are semantic, not keyword. Rephrase queries for better recall.'] } },
  { name: 'memory.save', description: 'Save a learning to agentmemory (honors DRY_RUN)', approvalLevel: 1, source: { file: 'src/tools/memory-explore.ts', line: 30, function: 'memorySave' } },
  { name: 'memory.sessions', description: 'List recent agentmemory sessions with status and observation counts (volatile store; may be empty)', approvalLevel: 0, source: { file: 'src/tools/memory-explore.ts', line: 141, function: 'memorySessions', tuningTips: ['GET /agentmemory/sessions on the server at localhost:3111.', 'Use for "what did we do last session" — then recap/timeline for detail.'] } },
  { name: 'memory.recap', description: 'Recap recent agentmemory sessions as a newest-first rollup (volatile store; may be empty)', approvalLevel: 0, source: { file: 'src/tools/memory-explore.ts', line: 175, function: 'memoryRecap', tuningTips: ['Built on GET /agentmemory/sessions — there is no dedicated /recap route.', 'Use for "recap yesterday / recently / last session".'] } },
  { name: 'memory.timeline', description: 'Chronological observations around an anchor point in agentmemory (volatile store; may be empty)', approvalLevel: 0, source: { file: 'src/tools/memory-explore.ts', line: 200, function: 'memoryTimeline', tuningTips: ['POST /agentmemory/timeline with an anchor (session/memory id or topic).', 'Use to reconstruct what happened around a specific moment.'] } },
  { name: 'life.query', description: 'Semantic search over Ben\'s Life OS data (read-only, Seeker-only; reaches financial/health data)', approvalLevel: 0, source: { file: 'src/tools/lifeos-explore.ts', line: 18, function: 'lifeQuery', tuningTips: ['Connects to Life OS DuckDB. Ensure the service is running.', 'Privacy-sensitive. Results are scoped to the Seeker agent only.'] } },
  { name: 'web.search', description: 'Search the web via Serper (Google Search) (Seeker-only; needs SERPER_API_KEY or ~/.life/secrets/serper.env)', approvalLevel: 0, source: { file: 'src/tools/web-explore.ts', line: 25, function: 'webSearch', tuningTips: ['Rate limited to 100 searches/month on free tier.', 'Returns top 10 results with snippets. Use webFetch for full text.'] } },
  { name: 'web.fetch', description: 'Fetch a URL and return its body text (Seeker-only; keyless, SSRF-guarded)', approvalLevel: 0, source: { file: 'src/tools/web-explore.ts', line: 55, function: 'webFetch', tuningTips: ['SSRF-guarded: blocks internal IPs, localhost, 169.254.x.x.', 'Max response size: 1MB. Truncates larger pages.'] } },
  { name: 'research.enqueue', description: 'Queue a background web-research job and return a jobId (Seeker-only; honors DRY_RUN)', approvalLevel: 1, source: { file: 'src/tools/research-explore.ts', line: 15, function: 'researchEnqueue' } },
  { name: 'research.status', description: 'Read the status/result of a queued research job by id (Seeker-only, read-only)', approvalLevel: 0, source: { file: 'src/tools/research-explore.ts', line: 45, function: 'researchStatus' } },
  { name: 'pm.checkPhaseGate', description: 'Phase-gate: check a project phase has produced its lifecycle-template artifact before marking it done (read-only, returns a structured refusal)', approvalLevel: 0, source: { file: 'src/tools/phase-gate.ts', line: 8, function: 'checkPhaseGate' } },
  { name: 'crew.listRuns', description: 'List recent crew runs newest-first with status/route/error, to locate a failure (Investigator diagnostic, read-only)', approvalLevel: 0, source: { file: 'src/tools/crew-runs.ts', line: 62, function: 'listRuns' } },
  { name: 'crew.getRun', description: 'Full trace for one crew run — steps, tool calls (inputs/outputs), changed files — the primary evidence for tracing a failure (Investigator diagnostic, read-only)', approvalLevel: 0, source: { file: 'src/tools/crew-runs.ts', line: 108, function: 'getRun' } },
  { name: 'code.read', description: 'Read a source file from the crew repo to confirm a failure mechanism in code (Investigator diagnostic, read-only, repo-fenced, secrets denied)', approvalLevel: 0, source: { file: 'src/tools/code-read.ts', line: 47, function: 'codeRead' } },
];
