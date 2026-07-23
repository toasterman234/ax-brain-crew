import { getLogger } from '../observability/logger.js';

interface GhRepo {
  name: string;
  fullName: string;
  description: string;
  url: string;
  language: string;
  pushedAt: string;
  private: boolean;
}

let _ghToken: string | null = null;
let _ghUser: string | null = null;

export function setGithubCredentials(token: string, user: string): void {
  _ghToken = token;
  _ghUser = user;
}

export function isGithubConfigured(): boolean {
  return _ghToken !== null && _ghToken.length > 0;
}

async function ghFetch(path: string): Promise<any> {
  if (!_ghToken) {
    throw new Error('GitHub not configured. Set GITHUB_TOKEN and GITHUB_USER in .env');
  }

  const url = path.startsWith('http') ? path : `https://api.github.com/${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${_ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ax-brain-crew-scout',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API error ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

export async function ghListRepos(): Promise<GhRepo[]> {
  const logger = getLogger();

  if (!isGithubConfigured()) {
    logger.warn('GitHub not configured for gh.list operation');
    throw new Error('GitHub not configured. Set GITHUB_TOKEN and GITHUB_USER in .env');
  }

  const repos: GhRepo[] = [];
  let page = 1;

  while (page <= 10) {
    const data = await ghFetch(`user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`);
    if (!Array.isArray(data) || data.length === 0) break;

    for (const repo of data) {
      repos.push({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description ?? '',
        url: repo.html_url,
        language: repo.language ?? '',
        pushedAt: repo.pushed_at,
        private: repo.private ?? false,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  logger.info({ count: repos.length }, 'ghListRepos completed');
  return repos;
}

export async function ghSearchCode(query: string, limit = 10): Promise<{ totalCount: number; items: { repo: string; path: string; url: string }[] }> {
  const logger = getLogger();

  if (!isGithubConfigured()) {
    logger.warn('GitHub not configured for gh.search operation');
    throw new Error('GitHub not configured.');
  }

  const data = await ghFetch(
    `search/code?q=${encodeURIComponent(query)}+user:${_ghUser}&per_page=${Math.min(limit, 100)}`,
  );

  const items = (data.items ?? []).map((item: any) => ({
    repo: item.repository?.full_name ?? '',
    path: item.path,
    url: item.html_url,
  }));

  return {
    totalCount: data.total_count ?? 0,
    items,
  };
}
