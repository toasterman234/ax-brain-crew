// Deterministic scorer for the Investigator agent's incident reports.
//
// The agent's structured output has no dedicated verdict/recurrence fields
// (AGENT_OUTPUT_SIGNATURE in executor.ts is generic across all agents), so we
// extract the verdict/prior-incident/failure-mode from the free-text
// responseText the same way a human reading the Slack summary would. This
// mirrors the code-based grader half of the Evals skill's grader pair
// (deterministic here; an llm_rubric judge covers root-cause soundness
// separately — see scripts/eval-incident.ts).

export type Verdict = 'NEW' | 'RECURRING' | 'POSSIBLY-RELATED';
export type FailureMode = 'rca-wrong' | 'prevention-missing' | 'prevention-insufficient';

export interface IncidentExpected {
  severity?: string;
  category?: string;
  verdict: Verdict;
  prior_incident?: string | null;
  failure_mode?: FailureMode;
}

export interface IncidentCase {
  id: string;
  input: string;
  expected: IncidentExpected;
}

export interface IncidentScoreBreakdown {
  verdictOk: boolean;
  priorIncidentOk: boolean; // true when expected.prior_incident is null (n/a)
  failureModeOk: boolean; // true when expected.failure_mode is undefined (n/a)
  categoryOk: boolean | null; // null when expected.category is undefined (not checked)
  score: number; // weighted 0–1
  extracted: {
    verdict: Verdict | null;
    priorIncident: string | null;
    failureMode: FailureMode | null;
    category: string | null;
  };
}

const VERDICT_PATTERNS: Array<[Verdict, RegExp]> = [
  ['POSSIBLY-RELATED', /possibly[\s-]related/i],
  ['RECURRING', /\brecurring\b/i],
  ['NEW', /\bnew\b(?!\s+(?:test|note|report))/i],
];

// Longer/more specific alternatives first — see repo convention on regex alternation order.
const FAILURE_MODE_PATTERNS: Array<[FailureMode, RegExp]> = [
  ['prevention-insufficient', /prevention[\s-]insufficient/i],
  ['prevention-missing', /prevention[\s-]missing/i],
  ['rca-wrong', /rca[\s-]wrong/i],
];

const CATEGORY_PATTERNS: RegExp[] = [
  /\brouting\b/i,
  /\btool-failure\b/i,
  /\bmisclassification\b/i,
  /\bhallucination\b/i,
  /\bsystem-design\b/i,
];

export function extractVerdict(text: string): Verdict | null {
  for (const [verdict, pattern] of VERDICT_PATTERNS) {
    if (pattern.test(text)) return verdict;
  }
  return null;
}

export function extractFailureMode(text: string): FailureMode | null {
  for (const [mode, pattern] of FAILURE_MODE_PATTERNS) {
    if (pattern.test(text)) return mode;
  }
  return null;
}

export function extractCategory(text: string): string | null {
  for (const pattern of CATEGORY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

// incident-004-seeker-proxy-timeout -> also matches bare "incident-004" mentions.
export function extractsPriorIncident(text: string, expectedSlug: string): boolean {
  const idMatch = expectedSlug.match(/incident-(\d{3})/);
  if (!idMatch) return text.includes(expectedSlug);
  const id = idMatch[1];
  return new RegExp(`incident-${id}\\b`).test(text) || text.includes(expectedSlug);
}

/**
 * Score one Investigator response against its expected case.
 * Weighting: verdict is the headline claim (0.5), prior-incident identification
 * and failure-mode classification matter most for RECURRING/POSSIBLY-RELATED
 * cases (0.3), category is a sanity check (0.2, only when expected).
 */
export function scoreIncidentResponse(
  responseText: string,
  expected: IncidentExpected,
): IncidentScoreBreakdown {
  const extractedVerdict = extractVerdict(responseText);
  const extractedFailureMode = extractFailureMode(responseText);
  const extractedCategory = extractCategory(responseText);

  const verdictOk = extractedVerdict === expected.verdict;

  const priorIncidentOk = expected.prior_incident
    ? extractsPriorIncident(responseText, expected.prior_incident)
    : true;

  const failureModeOk = expected.failure_mode
    ? extractedFailureMode === expected.failure_mode
    : true;

  const categoryOk =
    expected.category !== undefined ? extractedCategory === expected.category : null;

  let score = 0;
  score += verdictOk ? 0.5 : 0;
  score += priorIncidentOk ? 0.2 : 0;
  score += failureModeOk ? 0.1 : 0;
  score += categoryOk === null ? 0.2 : categoryOk ? 0.2 : 0;

  return {
    verdictOk,
    priorIncidentOk,
    failureModeOk,
    categoryOk,
    score,
    extracted: {
      verdict: extractedVerdict,
      priorIncident: priorIncidentOk && expected.prior_incident ? expected.prior_incident : null,
      failureMode: extractedFailureMode,
      category: extractedCategory,
    },
  };
}
