// Eval harness for braindump-triage flow.
// Runs historical braindumps through the flow and scores them against
// ground-truth decompositions (when available).
//
// Usage: npx tsx tests/smoke/braindump-triage-eval.ts

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeRuntime } from '../../src/runtime/init.js';

// ---------------------------------------------------------------------------
// Eval case definition
// ---------------------------------------------------------------------------

interface EvalCase {
  name: string;
  rawPath: string; // path to raw/ braindump file
  decomposedDir?: string; // path to Inbox/<date>-braindump/ (ground truth)
  expectedMinItems: number; // minimum items expected
  expectedMaxItems?: number; // maximum items expected (optional)
  skipReasons?: string[]; // known acceptable reasons for warnings
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface FlowScore {
  itemCount: number;
  slugMeanLength: number;
  slugMaxLength: number;
  confidenceDistribution: Record<string, number>;
  warnings: number;
  hasBase: boolean;
  hasRawSource: boolean;
  // Ground-truth comparisons (only when decomposedDir is available)
  groundTruthMatchRate?: number; // fraction of flow slugs that match ground truth slugs
  groundTruthExtra?: string[]; // ground truth slugs NOT in flow output
  groundTruthMissing?: string[]; // flow slugs NOT in ground truth
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRawBraindump(path: string): string {
  return readFileSync(resolve('vault', path), 'utf-8');
}

function getGroundTruthSlugs(dir: string): string[] {
  const fullPath = resolve('vault', dir);
  if (!existsSync(fullPath)) return [];
  const entries = readdirSync(fullPath);
  return entries
    .filter((e) => e.endsWith('.md'))
    .map((e) => e.replace(/\.md$/, ''))
    .sort();
}

function maxSlugLength(slugs: string[]): number {
  return slugs.reduce((max, s) => Math.max(max, s.length), 0);
}

function meanSlugLength(slugs: string[]): number {
  if (slugs.length === 0) return 0;
  return Math.round((slugs.reduce((sum, s) => sum + s.length, 0) / slugs.length) * 10) / 10;
}

function slugSimilarity(a: string, b: string): number {
  // Simple Jaccard-like similarity on word tokens.
  const aTokens = new Set(a.split('-').filter(Boolean));
  const bTokens = new Set(b.split('-').filter(Boolean));
  const intersection = new Set([...aTokens].filter((t) => bTokens.has(t)));
  const union = new Set([...aTokens, ...bTokens]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function bestMatch(slug: string, candidates: string[]): { match: string; score: number } | null {
  let best: { match: string; score: number } | null = null;
  for (const c of candidates) {
    const score = slugSimilarity(slug, c);
    if (!best || score > best.score) {
      best = { match: c, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Run one eval case
// ---------------------------------------------------------------------------

async function evaluateCase(
  runBraindumpTriageFlow: Function,
  evalCase: EvalCase,
): Promise<FlowScore> {
  const rawText = readRawBraindump(evalCase.rawPath);
  const groundTruth = evalCase.decomposedDir
    ? getGroundTruthSlugs(evalCase.decomposedDir)
    : [];

  console.log(`\n--- ${evalCase.name} ---`);
  console.log(`  Raw path: ${evalCase.rawPath} (${rawText.length} chars)`);
  if (groundTruth.length > 0) {
    console.log(`  Ground truth: ${groundTruth.length} items in ${evalCase.decomposedDir}`);
    console.log(`  Ground truth slugs: ${groundTruth.join(', ')}`);
  }

  const result = await runBraindumpTriageFlow({
    request: rawText,
    dryRun: true,
    runId: `eval-${evalCase.name.replace(/[^a-z0-9]/g, '-')}`,
  });

  const slugs: string[] = result.output.itemNotes.map((n: string) =>
    n.split('/').pop()!.replace(/\.md$/, ''),
  );

  const score: FlowScore = {
    itemCount: slugs.length,
    slugMeanLength: meanSlugLength(slugs),
    slugMaxLength: maxSlugLength(slugs),
    confidenceDistribution: {},
    warnings: result.output.warnings.length,
    hasBase: result.output.basePath === 'Inbox/Triage.base',
    hasRawSource: result.output.rawSourcePath.startsWith('raw/'),
  };

  // Build confidence distribution from response text
  const response = result.output.response;
  for (const level of ['high', 'medium', 'speculation']) {
    const emoji = level === 'high' ? '🟢' : level === 'medium' ? '🟡' : '🔴';
    const count = (response.match(new RegExp(emoji, 'g')) || []).length;
    if (count > 0) score.confidenceDistribution[level] = count;
  }

  console.log(`  Flow output: ${slugs.length} items`);
  console.log(`  Slugs: ${slugs.join(', ')}`);
  console.log(`  Slug mean/max length: ${score.slugMeanLength}/${score.slugMaxLength}`);
  console.log(`  Confidence: ${JSON.stringify(score.confidenceDistribution)}`);
  console.log(`  Warnings: ${score.warnings}`);
  for (const w of result.output.warnings) {
    console.log(`    ⚠ ${w}`);
  }

  // Ground truth comparison
  if (groundTruth.length > 0) {
    const matched: string[] = [];
    const missing: string[] = [];
    for (const gt of groundTruth) {
      const match = bestMatch(gt, slugs);
      if (match && match.score > 0.3) {
        matched.push(gt);
      } else {
        missing.push(gt);
      }
    }
    const extra = slugs.filter((s) => {
      const match = bestMatch(s, groundTruth);
      return !match || match.score <= 0.3;
    });

    score.groundTruthMatchRate =
      groundTruth.length > 0
        ? Math.round((matched.length / groundTruth.length) * 100)
        : 100;
    score.groundTruthExtra = extra;
    score.groundTruthMissing = missing;

    console.log(`  Ground truth match rate: ${score.groundTruthMatchRate}%`);
    if (missing.length > 0) console.log(`  Missing from flow: ${missing.join(', ')}`);
    if (extra.length > 0) console.log(`  Extra in flow: ${extra.join(', ')}`);
  }

  // Rule checks
  const issues: string[] = [];
  if (
    evalCase.expectedMinItems &&
    slugs.length < evalCase.expectedMinItems
  ) {
    issues.push(
      `Item count ${slugs.length} < expected min ${evalCase.expectedMinItems}`,
    );
  }
  if (
    evalCase.expectedMaxItems &&
    slugs.length > evalCase.expectedMaxItems
  ) {
    issues.push(
      `Item count ${slugs.length} > expected max ${evalCase.expectedMaxItems}`,
    );
  }
  if (!score.hasBase) issues.push('Missing Triage.base path');
  if (!score.hasRawSource) issues.push('Missing raw source path');
  if (score.warnings > (evalCase.skipReasons?.length ?? 0) * 2) {
    issues.push(
      `Unexpected warning count: ${score.warnings} (expected <= ${(evalCase.skipReasons?.length ?? 0) * 2})`,
    );
  }

  console.log(`  Issues: ${issues.length > 0 ? issues.join('; ') : '✅ none'}`);
  return score;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  initializeRuntime();

  const { runBraindumpTriageFlow } = await import(
    '../../src/flows/braindump-triage.js'
  );

  const cases: EvalCase[] = [
    // 2016-07-20 — has ground-truth decomposition
    {
      name: '2026-07-20 (with ground truth)',
      rawPath: 'raw/2026-07-20-braindump-original.md',
      decomposedDir: 'Inbox/2026-07-20-braindump',
      expectedMinItems: 3,
      expectedMaxItems: 6,
    },
    // 2016-07-19 #1 — 12 items, no ground truth folder
    {
      name: '2026-07-19 #1 (12 items)',
      rawPath: 'raw/2026-07-19-braindump-original.md',
      expectedMinItems: 8,
      expectedMaxItems: 16,
    },
    // 2016-07-19 #2 — 12 items, no ground truth folder
    {
      name: '2026-07-19 #2 (12 items)',
      rawPath: 'raw/2026-07-19-braindump-2-original.md',
      expectedMinItems: 8,
      expectedMaxItems: 16,
    },
  ];

  console.log('=== BRAINDUMP-TRIAGE EVAL ===');
  console.log(`${cases.length} historical braindumps being evaluated...\n`);

  const scores: { name: string; score: FlowScore; passed: boolean }[] = [];
  let passedCount = 0;

  for (const c of cases) {
    try {
      const score = await evaluateCase(runBraindumpTriageFlow, c);
      const passed =
        (score.itemCount >= c.expectedMinItems &&
          score.itemCount <= (c.expectedMaxItems ?? Infinity)) &&
        score.hasBase &&
        score.hasRawSource;
      scores.push({ name: c.name, score, passed });
      if (passed) passedCount++;
    } catch (err) {
      console.log(`\n--- ${c.name} ---`);
      console.log(`  ❌ FAILED: ${String(err)}`);
      scores.push({
        name: c.name,
        score: {
          itemCount: 0,
          slugMeanLength: 0,
          slugMaxLength: 0,
          confidenceDistribution: {},
          warnings: 1,
          hasBase: false,
          hasRawSource: false,
        },
        passed: false,
      });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Passed: ${passedCount}/${cases.length}`);
  for (const s of scores) {
    const status = s.passed ? '✅' : '❌';
    const gt = s.score.groundTruthMatchRate !== undefined
      ? ` | GT match: ${s.score.groundTruthMatchRate}%`
      : '';
    console.log(
      `  ${status} ${s.name}: ${s.score.itemCount} items, ` +
      `${s.score.warnings} warnings${gt}`,
    );
  }

  const allPassed = passedCount === cases.length;
  console.log(`\nVerdict: ${allPassed ? 'ALL PASS' : 'SOME FAILED'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Eval harness failed:', err);
  process.exit(1);
});
