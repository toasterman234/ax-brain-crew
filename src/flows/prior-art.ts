import { flow } from '@ax-llm/ax';
import { spawnSync } from 'node:child_process';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// Prior-art research flow — ax-native conversion of the Smithers prior-art
// workflow at ~/pi/.smithers/workflows/prior-art/workflow.tsx.
//
// Pipeline:
//
//   discover (.map, deterministic)   — patent CLI → structured matches
//   deepDive (.map, deterministic)   — parallel GitHub/npm/PyPI/crates.io API
//                                       calls for top N matches with heuristics
//   synthesize (.execute, LLM)       — typed ax() node produces adoption report
//   .returns(...)                     — typed PriorArtOutput
//
// This flow is READ-ONLY — it makes no vault writes, no file mutations.
// All work is either deterministic (patent CLI, REST API calls) or LLM
// (synthesis). No agents, no tool calls, no dryRun — this is a pure research
// tool following Design A.
//
// Naming convention: descriptive field names (not `input`/`request`) because
// ax v23's signature validator rejects generic field names.
// ---------------------------------------------------------------------------

export interface PriorArtInput extends Record<string, any> {
  /** Plain-English description of the dev tool, library, or component to search for. */
  userIdea: string;
  /** How many top matches to deep-dive (1-15). Defaults to 5. */
  topN?: number;
  /** Minimum cosine similarity (0-1) for a match to qualify for deep-dive. Defaults to 0.6. */
  minSimilarity?: number;
  /** The dispatcher's runId, threaded for tracing. */
  sessionRunId?: string;
}

export interface PriorArtOutput extends Record<string, unknown> {
  /** The idea that was searched. */
  idea: string;
  /** Discovery results from the patent CLI. */
  discovery: {
    keywords: string[];
    verdictLevel: string;
    verdictHeadline: string;
    sourcesChecked: string[];
    sourcesFailed: string[];
    totalMatches: number;
    elapsedSeconds: number;
  };
  /** Deep-dive results for each top match. */
  deepDives: Array<{
    name: string;
    source: string;
    url: string;
    githubRepo: string | null;
    recommendation: 'USE' | 'EVALUATE' | 'SKIP';
    stars: number | null;
    lastPush: string | null;
    license: string | null;
    archived: boolean | null;
    description: string | null;
    language: string | null;
    topics: string[];
    isComponent: boolean | null;
    similarity: number;
    error: string | null;
  }>;
  /** Matches that were below the similarity threshold (not deep-dived). */
  skippedMatches: Array<{
    name: string;
    source: string;
    similarity: number;
  }>;
  /** LLM synthesis: ranked adoption report. */
  synthesis: {
    summary: string;
    overallVerdict: 'use-existing' | 'evaluate-further' | 'build-from-scratch';
    recommendations: Array<{
      name: string;
      url: string;
      recommendation: 'USE' | 'EVALUATE' | 'SKIP';
      rationale: string;
    }>;
    caveats: string[];
    nextSteps: string[];
  } | null;
  /** Human-readable summary. */
  response: string;
  /** Warnings accumulated across the flow. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Patent CLI output shape (what patent --json emits)
// ---------------------------------------------------------------------------

interface PatentMatch {
  name: string;
  source: string;
  url: string;
  description: string;
  popularity: number | null;
  similarity: number;
}

interface PatentOutput {
  query?: string;
  keywords?: string[];
  verdict?: {
    level?: string;
    headline?: string;
    sources_checked?: string[];
    sources_failed?: string[];
  };
  matches?: PatentMatch[];
  elapsed_seconds?: number;
  meta?: { elapsed_seconds?: number };
}

// ---------------------------------------------------------------------------
// Internal types for flow state
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  idea: string;
  keywords: string[];
  verdictLevel: string;
  verdictHeadline: string;
  sourcesChecked: string[];
  sourcesFailed: string[];
  totalMatches: number;
  elapsedSeconds: number;
  matches: PatentMatch[];
}

interface DeepDiveResult {
  name: string;
  source: string;
  url: string;
  githubRepo: string | null;
  recommendation: 'USE' | 'EVALUATE' | 'SKIP';
  stars: number | null;
  lastPush: string | null;
  license: string | null;
  archived: boolean | null;
  description: string | null;
  language: string | null;
  topics: string[];
  isComponent: boolean | null;
  similarity: number;
  error: string | null;
}

interface RepoInfo {
  githubRepo: string | null;
  stars: number | null;
  lastPush: string | null;
  license: string | null;
  archived: boolean | null;
  description: string | null;
  language: string | null;
  topics: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// GitHub / registry API helpers (ported from Smithers)
// ---------------------------------------------------------------------------

const GH_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'prior-art-ax-flow/1.0',
};

/** Resolve a patent match to the best GitHub repo URL by inspecting the source. */
async function resolveGithubRepo(match: PatentMatch): Promise<string | null> {
  const url = match.url;
  const source = match.source;

  // Already a GitHub repo URL
  if (url.includes('github.com') && url.split('/').length >= 5) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return null;
  }

  // npm — use registry API to find repository URL
  if (source === 'npm') {
    try {
      const pkgName = url.split('/').pop()?.replace(/\/$/, '');
      if (!pkgName) return null;
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
      if (!res.ok) return null;
      const data = await res.json() as any;
      const repoUrl: string = data?.repository?.url ?? '';
      const cleaned = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
      if (cleaned.includes('github.com')) {
        const parts = new URL(cleaned).pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      }
    } catch { /* fall through */ }
  }

  // crates.io — use crates.io API
  if (source === 'crates-io') {
    try {
      const crateName = url.split('/').pop()?.replace(/\/$/, '');
      if (!crateName) return null;
      const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`);
      if (!res.ok) return null;
      const data = await res.json() as any;
      const repoUrl: string = data?.crate?.repository ?? '';
      if (repoUrl.includes('github.com')) {
        const parts = new URL(repoUrl).pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      }
    } catch { /* fall through */ }
  }

  // PyPI — use PyPI JSON API
  if (source === 'pypi') {
    try {
      const pkgName = url.split('/').pop()?.replace(/\/$/, '');
      if (!pkgName) return null;
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`);
      if (!res.ok) return null;
      const data = await res.json() as any;
      const urls: Record<string, string> = data?.info?.project_urls ?? {};
      const repoUrl = urls['Source'] ?? urls['Repository'] ?? urls['Homepage'] ?? '';
      if (repoUrl.includes('github.com')) {
        const parts = new URL(repoUrl).pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      }
    } catch { /* fall through */ }
  }

  // Hacker News / other — no GitHub repo to resolve
  return null;
}

/** Fetch GitHub repo metadata (no auth needed for public repos). */
async function fetchRepoInfo(ownerRepo: string): Promise<RepoInfo> {
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
      headers: GH_HEADERS,
    });
    if (!res.ok) {
      return {
        githubRepo: ownerRepo,
        stars: null,
        lastPush: null,
        license: null,
        archived: null,
        description: null,
        language: null,
        topics: [],
        error: `GitHub API returned ${res.status}`,
      };
    }
    const repo = await res.json() as any;
    return {
      githubRepo: ownerRepo,
      stars: repo.stargazers_count ?? null,
      lastPush: repo.pushed_at ?? null,
      license: repo.license?.spdx_id ?? null,
      archived: repo.archived ?? null,
      description: repo.description ?? null,
      language: repo.language ?? null,
      topics: repo.topics ?? [],
      error: null,
    };
  } catch (e: any) {
    return {
      githubRepo: ownerRepo,
      stars: null,
      lastPush: null,
      license: null,
      archived: null,
      description: null,
      language: null,
      topics: [],
      error: e.message ?? 'unknown fetch error',
    };
  }
}

/** Heuristic: guess if this is a library/component vs standalone app. */
function classifyIsComponent(repo: RepoInfo): boolean | null {
  if (repo.error) return null;

  const signals = {
    component: [
      'library', 'sdk', 'component', 'package', 'npm', 'module', 'plugin',
      'hook', 'util', 'helper', 'adapter', 'wrapper', 'binding', 'client',
      'api-client', 'framework',
    ],
    app: [
      'app', 'application', 'desktop', 'web-app', 'server', 'service',
      'dashboard', 'platform', 'cli', 'command-line', 'tool', 'bot', 'agent',
    ],
  };

  const desc = (repo.description ?? '').toLowerCase();
  const topics = repo.topics.map((t) => t.toLowerCase());

  const componentHits = signals.component.filter(
    (k) => desc.includes(k) || topics.includes(k),
  );
  const appHits = signals.app.filter(
    (k) => desc.includes(k) || topics.includes(k),
  );

  // Strong signals
  if (topics.includes('library') || topics.includes('sdk') || topics.includes('package'))
    return true;
  if (topics.includes('app') || topics.includes('cli') || topics.includes('server'))
    return false;

  return componentHits.length > appHits.length
    ? true
    : componentHits.length < appHits.length
      ? false
      : null;
}

/** Heuristic recommendation from repo metadata. */
function classifyRecommendation(
  repo: RepoInfo,
  similarity: number,
): 'USE' | 'EVALUATE' | 'SKIP' {
  if (repo.error) return 'SKIP';
  if (repo.archived) return 'SKIP';

  // High similarity, well-maintained, popular → USE
  if (similarity >= 0.8 && repo.stars && repo.stars >= 100 && hasRecentPush(repo.lastPush, 365)) {
    return 'USE';
  }

  // Good similarity, decent stars, maintained → USE
  if (similarity >= 0.7 && repo.stars && repo.stars >= 500 && hasRecentPush(repo.lastPush, 180)) {
    return 'USE';
  }

  // Low stars, stale, or low similarity → SKIP
  if (repo.stars && repo.stars < 10 && !hasRecentPush(repo.lastPush, 365)) return 'SKIP';
  if (!hasRecentPush(repo.lastPush, 730)) return 'SKIP';

  return 'EVALUATE';
}

function hasRecentPush(pushedAt: string | null, maxDays: number): boolean {
  if (!pushedAt) return false;
  const pushed = new Date(pushedAt);
  const now = new Date();
  const diffDays = (now.getTime() - pushed.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= maxDays;
}

// ---------------------------------------------------------------------------
// Build the flow
// ---------------------------------------------------------------------------

export function buildPriorArtFlow() {
  return (
    flow<PriorArtInput, PriorArtOutput>()
      // LLM synthesis node — typed ax() signature.
      .node(
        'synthesizeReport',
        'userIdea:string, discoveryJson:string, deepDivesJson:string -> synthesisSummary:string, overallVerdict:class "use-existing, evaluate-further, build-from-scratch", recommendations:json[] "array of {name, url, recommendation: USE|EVALUATE|SKIP, rationale}", caveats:json[] "string array", nextSteps:json[] "string array"',
      )

      // ── Phase 1: DISCOVER via patent CLI ──
      .map((state) => {
        const idea = state.userIdea;
        const warnings: string[] = [];

        let discovery: DiscoveryResult = {
          idea,
          keywords: [],
          verdictLevel: 'open',
          verdictHeadline: 'patent CLI did not run — binary not found or failed',
          sourcesChecked: [],
          sourcesFailed: [],
          totalMatches: 0,
          elapsedSeconds: 0,
          matches: [],
        };

        try {
          // patent writes JSON to stdout AND progress to stderr, and exits != 0
          // when --fast skips the LLM. Use spawnSync for clean separation.
          const proc = spawnSync(
            'patent',
            [idea, '--json', '--fast', '--limit', '50'],
            { encoding: 'utf-8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
          );
          const raw = (proc.stdout ?? '').trim();
          if (!raw) {
            const stderrSnippet = (proc.stderr ?? '').slice(0, 500);
            warnings.push(
              `patent produced no stdout output. Stderr: ${stderrSnippet || '(empty)'}`,
            );
            if (proc.error) {
              warnings.push(`patent spawn error: ${proc.error.message}`);
            }
            return { ...state, discovery, warnings };
          }

          let parsed: PatentOutput;
          try {
            parsed = JSON.parse(raw);
          } catch {
            warnings.push(
              `patent output was not valid JSON. Raw (first 500 chars): ${raw.slice(0, 500)}`,
            );
            return { ...state, discovery, warnings };
          }

          const verdict = parsed.verdict ?? {};
          discovery = {
            idea: parsed.query ?? idea,
            keywords: parsed.keywords ?? [],
            verdictLevel: verdict.level ?? 'open',
            verdictHeadline: verdict.headline ?? '',
            sourcesChecked: verdict.sources_checked ?? [],
            sourcesFailed: verdict.sources_failed ?? [],
            totalMatches: (parsed.matches ?? []).length,
            elapsedSeconds: parsed.elapsed_seconds ?? parsed.meta?.elapsed_seconds ?? 0,
            matches: (parsed.matches ?? []).map((m) => ({
              name: m.name ?? '',
              source: m.source ?? 'unknown',
              url: m.url ?? '',
              description: m.description ?? '',
              popularity: m.popularity ?? null,
              similarity: m.similarity ?? 0,
            })),
          };
        } catch (e: any) {
          // This catch should never fire with spawnSync (it doesn't throw).
          // It's here defensively in case the JSON.parse or map steps throw.
          warnings.push(`patent processing failed: ${e.message ?? String(e)}`);
        }

        return { ...state, discovery, warnings };
      })

      // ── Phase 2: DEEP-DIVE top N matches ──
      .map(async (state) => {
        const discovery = state.discovery as DiscoveryResult;
        const topN = state.topN ?? 5;
        const minSimilarity = state.minSimilarity ?? 0.6;
        const warnings = [...(state.warnings as string[])];

        const qualityMatches = discovery.matches.filter(
          (m) => m.similarity >= minSimilarity,
        );
        const topMatches = qualityMatches.slice(0, topN);
        const skipped = qualityMatches
          .slice(topN)
          .map((m) => ({ name: m.name, source: m.source, similarity: m.similarity }));

        let deepDives: DeepDiveResult[] = [];
        if (topMatches.length === 0) {
          if (discovery.totalMatches > 0) {
            warnings.push(
              `No matches met the minimum similarity threshold (${Math.round(minSimilarity * 100)}%). ` +
                `${discovery.totalMatches} total matches found, best similarity: ` +
                `${Math.round(Math.max(...discovery.matches.map((m) => m.similarity)) * 100)}%.`,
            );
          }
        } else {
          // Run all deep-dives in parallel (matching the Smithers Parallel node).
          const deepDivePromises = topMatches.map(
            async (match): Promise<DeepDiveResult> => {
              try {
                const repo = await resolveGithubRepo(match);
                const info: RepoInfo = repo
                  ? await fetchRepoInfo(repo)
                  : {
                      githubRepo: null,
                      stars: null,
                      lastPush: null,
                      license: null,
                      archived: null,
                      description: null,
                      language: null,
                      topics: [],
                      error: 'No GitHub repo found for this match.',
                    };

                return {
                  name: match.name,
                  source: match.source,
                  url: match.url,
                  githubRepo: info.githubRepo ?? null,
                  recommendation: info.githubRepo
                    ? classifyRecommendation(info, match.similarity)
                    : 'SKIP',
                  stars: info.stars ?? null,
                  lastPush: info.lastPush ?? null,
                  license: info.license ?? null,
                  archived: info.archived ?? null,
                  description: info.description ?? null,
                  language: info.language ?? null,
                  topics: info.topics ?? [],
                  isComponent: classifyIsComponent(info),
                  similarity: match.similarity,
                  error: info.error ?? null,
                };
              } catch (e: any) {
                return {
                  name: match.name,
                  source: match.source,
                  url: match.url,
                  githubRepo: null,
                  recommendation: 'SKIP',
                  stars: null,
                  lastPush: null,
                  license: null,
                  archived: null,
                  description: null,
                  language: null,
                  topics: [],
                  isComponent: null,
                  similarity: match.similarity,
                  error: e.message ?? 'unknown error during deep-dive',
                };
              }
            },
          );
          deepDives = await Promise.all(deepDivePromises);
        }

        return {
          ...state,
          deepDives,
          skippedMatches: skipped,
          allDeepDived: topMatches.length > 0 && deepDives.length >= topMatches.length,
          warnings,
        };
      })

      // ── Phase 3: SYNTHESIZE via LLM ──
      .branch((state) => (state.allDeepDived as boolean) && (state.deepDives as DeepDiveResult[]).length > 0)
        .when(true)
          .execute('synthesizeReport', (state) => ({
            userIdea: state.userIdea,
            discoveryJson: JSON.stringify(state.discovery),
            deepDivesJson: JSON.stringify(state.deepDives),
          }))
          .map((state) => ({
            ...state,
            synthesisResult: (() => {
              const r: any = state.synthesizeReportResult;
              return {
                summary: r?.synthesisSummary ?? '',
                overallVerdict: r?.overallVerdict ?? 'build-from-scratch',
                recommendations: r?.recommendations ?? [],
                caveats: r?.caveats ?? [],
                nextSteps: r?.nextSteps ?? [],
              };
            })(),
          }))
        .when(false)
          .map((state) => ({
            ...state,
            synthesisResult: null as PriorArtOutput['synthesis'],
          }))
      .merge()

      // ── Phase 4: Build response ──
      .map((state) => {
        const discovery = state.discovery as DiscoveryResult;
        const deepDives = state.deepDives as DeepDiveResult[];
        const synthesis = state.synthesisResult as PriorArtOutput['synthesis'];

        const lines: string[] = [];
        lines.push(`# Prior Art: "${discovery.idea}"`);
        lines.push('');
        lines.push(`**Verdict:** ${discovery.verdictHeadline}`);
        lines.push(
          `**Sources:** ${discovery.sourcesChecked.join(', ') || 'none'} ` +
            `(failed: ${discovery.sourcesFailed.join(', ') || 'none'})`,
        );
        lines.push(`**Matches:** ${discovery.totalMatches} total (${discovery.elapsedSeconds}s)`);
        lines.push('');

        if (deepDives.length > 0) {
          lines.push('## Top Matches');
          for (const d of deepDives) {
            const stars = d.stars != null ? `★ ${d.stars.toLocaleString()}` : '? stars';
            const push = d.lastPush ? `, last push ${d.lastPush.slice(0, 10)}` : '';
            const rec = d.recommendation === 'USE' ? '✅ USE' : d.recommendation === 'EVALUATE' ? '🔍 EVALUATE' : '⏭ SKIP';
            lines.push(`- **${d.name}** (${d.source}) — ${rec}`);
            lines.push(`  ${stars}${push}`);
            if (d.description) lines.push(`  ${d.description.slice(0, 200)}`);
            if (d.error) lines.push(`  ⚠️ ${d.error}`);
          }
          lines.push('');
        }

        if (synthesis) {
          lines.push('## Synthesis');
          lines.push(synthesis.summary);
          lines.push('');
          lines.push(`**Overall:** ${synthesis.overallVerdict}`);
          if (synthesis.recommendations.length > 0) {
            lines.push('');
            lines.push('### Recommendations');
            for (const r of synthesis.recommendations) {
              lines.push(`- **${r.recommendation}** — ${r.name}: ${r.rationale}`);
            }
          }
          if (synthesis.caveats.length > 0) {
            lines.push('');
            lines.push('### Caveats');
            for (const c of synthesis.caveats) {
              lines.push(`- ⚠️ ${c}`);
            }
          }
          if (synthesis.nextSteps.length > 0) {
            lines.push('');
            lines.push('### Next Steps');
            for (const n of synthesis.nextSteps) {
              lines.push(`- ${n}`);
            }
          }
        } else if (discovery.totalMatches === 0) {
          lines.push('## No matches found');
          lines.push(
            `Patent searched: ${discovery.sourcesChecked.join(', ') || 'none'} ` +
              `(failed: ${discovery.sourcesFailed.join(', ') || 'none'}). ` +
              'This does not prove nothing exists — try broader search terms.',
          );
        }

        return {
          ...state,
          responseText: lines.join('\n'),
        };
      })

      .returns((state) => ({
        idea: (state.discovery as DiscoveryResult).idea,
        discovery: {
          keywords: (state.discovery as DiscoveryResult).keywords,
          verdictLevel: (state.discovery as DiscoveryResult).verdictLevel,
          verdictHeadline: (state.discovery as DiscoveryResult).verdictHeadline,
          sourcesChecked: (state.discovery as DiscoveryResult).sourcesChecked,
          sourcesFailed: (state.discovery as DiscoveryResult).sourcesFailed,
          totalMatches: (state.discovery as DiscoveryResult).totalMatches,
          elapsedSeconds: (state.discovery as DiscoveryResult).elapsedSeconds,
        },
        deepDives: (state.deepDives as DeepDiveResult[]).map((d) => ({
          name: d.name,
          source: d.source,
          url: d.url,
          githubRepo: d.githubRepo,
          recommendation: d.recommendation,
          stars: d.stars,
          lastPush: d.lastPush,
          license: d.license,
          archived: d.archived,
          description: d.description,
          language: d.language,
          topics: d.topics,
          isComponent: d.isComponent,
          similarity: d.similarity,
          error: d.error,
        })),
        skippedMatches: state.skippedMatches as PriorArtOutput['skippedMatches'],
        synthesis: state.synthesisResult as PriorArtOutput['synthesis'],
        response: state.responseText as string,
        warnings: state.warnings as string[],
      }))
  );
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

export interface RunPriorArtFlowResult {
  output: PriorArtOutput;
  finalResponse: string;
}

export async function runPriorArtFlow(args: {
  idea: string;
  topN?: number;
  minSimilarity?: number;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunPriorArtFlowResult> {
  const logger = getLogger();
  const wf = buildPriorArtFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.prior-art');

  logger.info(
    { runId: args.runId, idea: args.idea, topN: args.topN, minSimilarity: args.minSimilarity },
    'prior-art flow started',
  );

  const output = (await wf.forward(
    llm,
    {
      userIdea: args.idea,
      topN: args.topN,
      minSimilarity: args.minSimilarity,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as PriorArtOutput;

  logger.info(
    {
      runId: args.runId,
      totalMatches: output.discovery.totalMatches,
      deepDives: output.deepDives.length,
    },
    'prior-art flow completed',
  );

  return {
    output,
    finalResponse: output.response,
  };
}

registerFlow({
  id: 'prior-art',
  name: 'Prior Art',
  description: 'Researches existing tools before building. Searches package registries, GitHub, and Hacker News for ranked adoption recommendations.',
  triggers: ['prior art', 'research existing tools', "what's out there for", 'search for existing', 'find tools for', 'look for a library', 'is there a tool for', 'any existing tools for', 'prior art for'],
  approvalRequired: false,
  sourceFile: 'src/flows/prior-art.ts',
  run: async (args) => runPriorArtFlow({ idea: args.request, runId: args.runId }),
});
