import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types (matching the dataset schema)
// ---------------------------------------------------------------------------

interface DatasetClaim {
  id: string;
  sessionId: string;
  project: string;
  promptExcerpt: string;
  claim: string;
  verdict: 'supported' | 'unsupported' | 'contradicted' | 'unverifiable';
  evidence: string;
  confidence: number;
  labelConfidence: number;
  needsHumanReview: boolean;
  verdictSource: 'manual' | 'llm-assisted' | 'heuristic';
  notes?: string;
}

interface ClaimVerificationDataset {
  version: string;
  created: string;
  description: string;
  labelingMethodology: string;
  sourceSessions: number;
  verdictTaxonomy: Record<string, string>;
  stats: {
    totalClaims: number;
    byVerdict: Record<string, number>;
    bySession: Record<string, number>;
    lowConfidenceCount: number;
    needsHumanReview: number;
  };
  claims: DatasetClaim[];
}

// ---------------------------------------------------------------------------
// Known source sessions (from DSPy Pass 2 report)
// ---------------------------------------------------------------------------

const KNOWN_SESSIONS = [
  'bf69b8f4',
  '171e4325',
  '7653e5d8',
  '81c390a9',
  '46a43715',
  '8a26c232',
];

const DATASET_PATH = path.resolve(
  import.meta.dirname,
  '../data/claim-verification-dataset.json',
);

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export function validateDataset(dataset: ClaimVerificationDataset): string[] {
  const errors: string[] = [];

  if (dataset.version !== '1.0.0') errors.push('Wrong version');
  if (!Array.isArray(dataset.claims)) errors.push('Missing claims array');
  if (dataset.claims.length === 0) errors.push('No claims');
  if (dataset.stats.totalClaims !== dataset.claims.length) {
    errors.push(
      `Stats mismatch: totalClaims=${dataset.stats.totalClaims} vs claims.length=${dataset.claims.length}`,
    );
  }

  // Verify byVerdict stats
  const computedVerdicts: Record<string, number> = {};
  for (const c of dataset.claims) {
    computedVerdicts[c.verdict] = (computedVerdicts[c.verdict] || 0) + 1;
  }
  for (const [v, count] of Object.entries(dataset.stats.byVerdict)) {
    if (computedVerdicts[v] !== count) {
      errors.push(`Verdict stat mismatch: ${v}=${count} (computed=${computedVerdicts[v]})`);
    }
  }

  // Verify bySession stats
  const computedSessions: Record<string, number> = {};
  for (const c of dataset.claims) {
    computedSessions[c.sessionId] = (computedSessions[c.sessionId] || 0) + 1;
  }
  for (const [sid, count] of Object.entries(dataset.stats.bySession)) {
    if (computedSessions[sid] !== count) {
      errors.push(`Session stat mismatch: ${sid}=${count} (computed=${computedSessions[sid]})`);
    }
  }

  // Verify lowConfidenceCount
  const lowConf = dataset.claims.filter((c) => c.labelConfidence < 0.7).length;
  if (dataset.stats.lowConfidenceCount !== lowConf) {
    errors.push(
      `Low confidence mismatch: ${dataset.stats.lowConfidenceCount} vs ${lowConf}`,
    );
  }

  // Verify needsHumanReview
  const needsReview = dataset.claims.filter((c) => c.needsHumanReview).length;
  if (dataset.stats.needsHumanReview !== needsReview) {
    errors.push(
      `Human review mismatch: ${dataset.stats.needsHumanReview} vs ${needsReview}`,
    );
  }

  // Per-claim validations
  for (const claim of dataset.claims) {
    if (!claim.id?.startsWith('claim-')) {
      errors.push(`Invalid id on claim: ${claim.id}`);
    }
    if (!claim.claim?.trim()) {
      errors.push(`Empty claim text on ${claim.id}`);
    }
    if (!['supported', 'unsupported', 'contradicted', 'unverifiable'].includes(claim.verdict)) {
      errors.push(`Invalid verdict on ${claim.id}: ${claim.verdict}`);
    }
    if (claim.labelConfidence < 0 || claim.labelConfidence > 1) {
      errors.push(`Invalid labelConfidence on ${claim.id}: ${claim.labelConfidence}`);
    }
    if (claim.confidence < 0 || claim.confidence > 1) {
      errors.push(`Invalid confidence on ${claim.id}: ${claim.confidence}`);
    }
    if (!claim.sessionId) {
      errors.push(`Missing sessionId on ${claim.id}`);
    }
    if (!claim.promptExcerpt?.trim()) {
      errors.push(`Missing promptExcerpt on ${claim.id}`);
    }
    if (!claim.evidence?.trim()) {
      errors.push(`Missing evidence on ${claim.id}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claim verification dataset (from data/claim-verification-dataset.json)', () => {
  let dataset: ClaimVerificationDataset;

  beforeAll(() => {
    const raw = fs.readFileSync(DATASET_PATH, 'utf-8');
    dataset = JSON.parse(raw) as ClaimVerificationDataset;
  });

  // --- Format & Integrity ---

  it('is valid JSON with correct version', () => {
    const errors = validateDataset(dataset);
    expect(errors).toEqual([]);
  });

  it('has exactly 22 claims', () => {
    expect(dataset.claims).toHaveLength(22);
  });

  it('stats are self-consistent', () => {
    expect(dataset.stats.totalClaims).toBe(dataset.claims.length);

    // byVerdict sums to total
    const verdictSum = Object.values(dataset.stats.byVerdict).reduce((a, b) => a + b, 0);
    expect(verdictSum).toBe(dataset.stats.totalClaims);

    // bySession sums to total
    const sessionSum = Object.values(dataset.stats.bySession).reduce((a, b) => a + b, 0);
    expect(sessionSum).toBe(dataset.stats.totalClaims);
  });

  // --- Session Coverage ---

  it('covers all 6 source sessions', () => {
    const covered = new Set(dataset.claims.map((c) => c.sessionId));
    expect(covered.size).toBe(6);
    for (const sid of KNOWN_SESSIONS) {
      expect(covered.has(sid)).toBe(true);
    }
  });

  it('each session has at least 3 claims', () => {
    for (const sid of KNOWN_SESSIONS) {
      const count = dataset.claims.filter((c) => c.sessionId === sid).length;
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  it('the richest session (7653e5d8, 151 obs) has at least 5 claims', () => {
    const count = dataset.claims.filter((c) => c.sessionId === '7653e5d8').length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  // --- Verdict Distribution ---

  it('has all four verdict types', () => {
    const verdicts = new Set(dataset.claims.map((c) => c.verdict));
    expect(verdicts.has('supported')).toBe(true);
    expect(verdicts.has('unverifiable')).toBe(true);
    expect(verdicts.has('unsupported')).toBe(true);
    expect(verdicts.has('contradicted')).toBe(true);
  });

  it('supported claims are the majority', () => {
    const supported = dataset.stats.byVerdict.supported!;
    expect(supported).toBeGreaterThan(
      Math.max(
        dataset.stats.byVerdict.unverifiable!,
        dataset.stats.byVerdict.unsupported!,
        dataset.stats.byVerdict.contradicted!,
      ),
    );
  });

  it('at least one contradicted claim exists', () => {
    expect(dataset.stats.byVerdict.contradicted).toBeGreaterThanOrEqual(1);
  });

  // --- Label Quality ---

  it('high-confidence labels (≥0.8) outnumber low-confidence (<0.7)', () => {
    const high = dataset.claims.filter((c) => c.labelConfidence >= 0.8).length;
    const low = dataset.claims.filter((c) => c.labelConfidence < 0.7).length;
    expect(high).toBeGreaterThan(low);
  });

  it('all claims flagged for human review have labelConfidence < 0.7', () => {
    for (const claim of dataset.claims) {
      if (claim.needsHumanReview) {
        expect(claim.labelConfidence).toBeLessThan(0.7);
      }
    }
  });

  it('at least 5 claims need human review', () => {
    expect(dataset.stats.needsHumanReview).toBeGreaterThanOrEqual(5);
  });

  it('all claims have valid ids (claim-NNN format)', () => {
    for (const claim of dataset.claims) {
      expect(claim.id).toMatch(/^claim-\d{3}$/);
    }
  });

  // --- Evidence Quality ---

  it('every claim has non-trivial evidence (≥20 chars)', () => {
    for (const claim of dataset.claims) {
      expect(claim.evidence.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('supported claims have stronger evidence than unverifiable ones', () => {
    const supportedEvidence = dataset.claims
      .filter((c) => c.verdict === 'supported')
      .map((c) => c.evidence.length);
    const unverifiableEvidence = dataset.claims
      .filter((c) => c.verdict === 'unverifiable')
      .map((c) => c.evidence.length);

    const avgSupported =
      supportedEvidence.reduce((a, b) => a + b, 0) / supportedEvidence.length;
    const avgUnverifiable =
      unverifiableEvidence.reduce((a, b) => a + b, 0) / unverifiableEvidence.length;

    // Supported claims should have more detailed evidence on average
    expect(avgSupported).toBeGreaterThanOrEqual(avgUnverifiable);
  });

  // --- Session-Specific Claims ---

  it('has a contradicted claim from 7653e5d8 (famous-hedgehog) about RLM', () => {
    const badClaim = dataset.claims.find(
      (c) =>
        c.sessionId === '7653e5d8' &&
        c.verdict === 'contradicted',
    );
    expect(badClaim).toBeDefined();
    expect(badClaim!.claim).toContain('RLM');
  });

  it('has a supported claim from 46a43715 (venomous-hound) about Mira dashboard', () => {
    const miraClaim = dataset.claims.find(
      (c) =>
        c.sessionId === '46a43715' &&
        c.verdict === 'supported' &&
        c.claim.toLowerCase().includes('dashboard'),
    );
    expect(miraClaim).toBeDefined();
    expect(miraClaim!.evidence).toContain('read-only mirror');
  });

  it('has a supported claim from 171e4325 (just-stingray) about beads', () => {
    const beadsClaim = dataset.claims.find(
      (c) =>
        c.sessionId === '171e4325' &&
        c.verdict === 'supported' &&
        c.claim.toLowerCase().includes('beads'),
    );
    expect(beadsClaim).toBeDefined();
    expect(beadsClaim!.evidence).toContain('BD_NO_DB');
  });

  it('claims from 8a26c232 (ben-workspace ADR review) reference ADR context', () => {
    const adrClaims = dataset.claims.filter((c) => c.sessionId === '8a26c232');
    expect(adrClaims.length).toBeGreaterThanOrEqual(3);

    const adrEvidenceCount = adrClaims.filter(
      (c) => c.evidence.toLowerCase().includes('adr'),
    ).length;
    expect(adrEvidenceCount).toBeGreaterThanOrEqual(2);
  });

  // --- GEPA Readiness ---

  it('has train/holdout split potential (≥2 sessions per verdict)', () => {
    // For a meaningful split by verdict, we need multiple sessions
    // that contribute to each verdict type
    const sessionsForVerdict = (v: string) =>
      new Set(
        dataset.claims.filter((c) => c.verdict === v).map((c) => c.sessionId),
      ).size;

    expect(sessionsForVerdict('supported')).toBeGreaterThanOrEqual(2);
    expect(sessionsForVerdict('unverifiable')).toBeGreaterThanOrEqual(2);
  });

  it('has enough claims for GEPA bootstrap (≥15)', () => {
    expect(dataset.claims.length).toBeGreaterThanOrEqual(15);
  });
});
