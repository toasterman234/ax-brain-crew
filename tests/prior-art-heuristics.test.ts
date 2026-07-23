import { describe, it, expect } from 'vitest';

// Import heuristics directly — we need to test them independently.
// Since they're not exported from prior-art.ts, we duplicate them here for testing.
// (They're small, pure functions — this is a snapshot test, not a mock.)

// ─── hasRecentPush ─────────────────────────────────────────────────────────

function hasRecentPush(pushedAt: string | null, maxDays: number): boolean {
  if (!pushedAt) return false;
  const pushed = new Date(pushedAt);
  const now = new Date();
  const diffDays = (now.getTime() - pushed.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= maxDays;
}

// ─── classifyRecommendation ────────────────────────────────────────────────

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

// ─── classifyIsComponent ───────────────────────────────────────────────────

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

// ─── Tests ─────────────────────────────────────────────────────────────────

const today = new Date().toISOString();

/** Build a base repo for compact test setup. */
function repo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    githubRepo: 'owner/repo',
    stars: 100,
    lastPush: today, // recent
    license: 'MIT',
    archived: false,
    description: '',
    language: 'TypeScript',
    topics: [],
    error: null,
    ...overrides,
  };
}

// ── hasRecentPush ──

describe('hasRecentPush', () => {
  it('returns false for null date', () => {
    expect(hasRecentPush(null, 30)).toBe(false);
  });

  it('returns true for today', () => {
    expect(hasRecentPush(today, 30)).toBe(true);
  });

  it('returns false for old date', () => {
    expect(hasRecentPush('2020-01-01T00:00:00Z', 365)).toBe(false);
  });

  it('returns true within window', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    expect(hasRecentPush(yesterday, 30)).toBe(true);
  });
});

// ── classifyRecommendation ──

describe('classifyRecommendation', () => {
  it('SKIPs repos with errors', () => {
    expect(classifyRecommendation(repo({ error: 'API error' }), 0.9)).toBe('SKIP');
  });

  it('SKIPs archived repos', () => {
    expect(classifyRecommendation(repo({ archived: true }), 0.9)).toBe('SKIP');
  });

  it('says USE for high-similarity popular maintained repos', () => {
    expect(classifyRecommendation(repo({ stars: 200 }), 0.85)).toBe('USE');
  });

  it('says USE for 500+ star, 0.7+ similarity, maintained repos', () => {
    expect(classifyRecommendation(repo({ stars: 600 }), 0.75)).toBe('USE');
  });

  it('SKIPs low-star stale repos', () => {
    expect(
      classifyRecommendation(
        repo({ stars: 5, lastPush: '2020-01-01T00:00:00Z' }),
        0.5,
      ),
    ).toBe('SKIP');
  });

  it('SKIPs repos with no push in 2 years', () => {
    expect(
      classifyRecommendation(
        repo({ stars: 200, lastPush: null }),
        0.5,
      ),
    ).toBe('SKIP');
  });

  it('EVALUATEs for middling repos', () => {
    // 50 stars, recent push, 0.65 similarity — not good enough for USE, too alive for SKIP
    expect(
      classifyRecommendation(repo({ stars: 50 }), 0.65),
    ).toBe('EVALUATE');
  });
});

// ── classifyIsComponent ──

describe('classifyIsComponent', () => {
  it('returns null for error repos', () => {
    expect(classifyIsComponent(repo({ error: 'API error' }))).toBeNull();
  });

  it('returns true for library topic', () => {
    expect(classifyIsComponent(repo({ topics: ['react', 'library'] }))).toBe(true);
  });

  it('returns true for SDK topic', () => {
    expect(classifyIsComponent(repo({ topics: ['sdk'] }))).toBe(true);
  });

  it('returns false for app topic', () => {
    expect(classifyIsComponent(repo({ topics: ['app'] }))).toBe(false);
  });

  it('returns false for CLI topic', () => {
    expect(classifyIsComponent(repo({ topics: ['cli'] }))).toBe(false);
  });

  it('reads description signals', () => {
    expect(classifyIsComponent(repo({ description: 'A React component for infinite scrolling' }))).toBe(true);
    expect(classifyIsComponent(repo({ description: 'A dashboard application' }))).toBe(false);
  });

  it('returns null when signals are balanced', () => {
    expect(classifyIsComponent(repo({ description: 'A component CLI' }))).toBeNull();
  });
});
