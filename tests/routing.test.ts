import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRequest } from '../src/routing/normalize.js';
import type { ValidatedAgent } from '../src/registry/loader.js';
import { TOOL_REGISTRY } from '../src/tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockAgents: ValidatedAgent[] = [
  {
    id: 'scribe',
    name: 'Scribe',
    description: 'Converts rough captures into structured notes',
    instructions: 'You are Scribe',
    modelTier: 'fast',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.write','vault.append','vault.readFrontmatter','vault.updateFrontmatter'] as string[]).includes(t.name),
    ),
    triggers: [
      'save this thought', 'clean up this note', 'turn this into a note',
      'capture this idea', 'write a note about', 'create a note',
      'draft a note', 'record this',
    ],
    handoffs: { allowedTargets: [] },
  },
  {
    id: 'seeker',
    name: 'Seeker',
    description: 'Searches the vault and synthesizes knowledge',
    instructions: 'You are Seeker',
    modelTier: 'smart',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.list'] as string[]).includes(t.name),
    ),
    triggers: [
      'find my notes about', 'what have I written about', 'search my vault',
      'summarize what I know', 'what do I know about', 'look up',
      'any notes on', 'research',
    ],
    handoffs: { allowedTargets: [] },
  },
  {
    id: 'sorter',
    name: 'Sorter',
    description: 'Classifies and files notes',
    instructions: 'You are Sorter',
    modelTier: 'fast',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.list','vault.move','vault.updateFrontmatter'] as string[]).includes(t.name),
    ),
    triggers: [
      'organize my inbox', 'file this note', 'sort these notes',
      'classify this', 'triage my inbox', 'clean up my vault',
      'move this note', 'tidy up',
    ],
    handoffs: { allowedTargets: [] },
  },
  {
    id: 'architect',
    name: 'Architect',
    description: 'Creates project structures, MOCs, and scaffolds new vault areas',
    instructions: 'You are Architect',
    modelTier: 'smart',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.list','vault.write'] as string[]).includes(t.name),
    ),
    triggers: [
      'scaffold a project', 'create a structure', 'build an MOC',
      'set up a new area', 'design a folder layout', 'create an index',
    ],
    handoffs: { allowedTargets: ['sorter', 'seeker'] },
  },
  {
    id: 'connector',
    name: 'Connector',
    description: 'Discovers related notes, suggests links, identifies orphans and themes',
    instructions: 'You are Connector',
    modelTier: 'smart',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.list','vault.readFrontmatter','vault.write','vault.append','vault.updateFrontmatter'] as string[]).includes(t.name),
    ),
    triggers: [
      'connect my notes', 'find related notes', 'suggest links',
      'identify orphans', 'what themes span', 'discover connections',
      'link related',
    ],
    handoffs: { allowedTargets: ['librarian', 'sorter'] },
  },
  {
    id: 'librarian',
    name: 'Librarian',
    description: 'Audits vault consistency, detects broken links, stale structures, and frontmatter issues',
    instructions: 'You are Librarian',
    modelTier: 'smart',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['vault.read','vault.search','vault.list','vault.readFrontmatter','vault.write','vault.updateFrontmatter'] as string[]).includes(t.name),
    ),
    triggers: [
      'audit my vault', 'check vault health', 'find broken links',
      'detect stale notes', 'validate frontmatter', 'vault consistency',
      'inspect the vault',
    ],
    handoffs: { allowedTargets: ['connector', 'sorter'] },
  },
  {
    id: 'scout',
    name: 'Scout',
    description: 'Explores local filesystem and GitHub to discover projects, codebases, and repositories',
    instructions: 'You are Scout',
    modelTier: 'smart',
    allowedTools: TOOL_REGISTRY.filter(
      (t) => (['sys.ls','sys.walk','gh.repos','gh.search'] as string[]).includes(t.name),
    ),
    triggers: [
      'explore my projects', 'find my projects', 'scan my filesystem',
      'what projects do I have', 'discover my repos', 'inventory my projects',
      'search github for', 'find project directories',
    ],
    handoffs: { allowedTargets: ['scribe'] },
  },
];

interface RoutingCase {
  id: string;
  expectedAgent: string;
  request: string;
}

let cases: RoutingCase[] = [];

beforeAll(() => {
  const data = JSON.parse(
    readFileSync(
      resolve(__dirname, 'fixtures', 'routing-cases.json'),
      'utf-8',
    ),
  );
  cases = data.cases as RoutingCase[];
});

describe('Deterministic routing', () => {
  it('routes /scribe prefix', () => {
    const result = normalizeRequest('/scribe capture this', mockAgents);
    expect(result?.routeId).toBe('scribe');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /seeker prefix', () => {
    const result = normalizeRequest('/seeker find notes', mockAgents);
    expect(result?.routeId).toBe('seeker');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /sorter prefix', () => {
    const result = normalizeRequest('/sorter organize', mockAgents);
    expect(result?.routeId).toBe('sorter');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /architect prefix', () => {
    const result = normalizeRequest('/architect scaffold a project', mockAgents);
    expect(result?.routeId).toBe('architect');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /connector prefix', () => {
    const result = normalizeRequest('/connector find related notes', mockAgents);
    expect(result?.routeId).toBe('connector');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /librarian prefix', () => {
    const result = normalizeRequest('/librarian audit vault', mockAgents);
    expect(result?.routeId).toBe('librarian');
    expect(result?.confidence).toBe(1.0);
  });

  it('routes /scout prefix', () => {
    const result = normalizeRequest('/scout find my projects', mockAgents);
    expect(result?.routeId).toBe('scout');
    expect(result?.confidence).toBe(1.0);
  });

  it('rejects unknown prefix', () => {
    const result = normalizeRequest('/unknown do stuff', mockAgents);
    expect(result?.routeType).toBe('none');
  });
});

describe('Routing dataset coverage', () => {
  it('has at least 55 test cases with valid expected agents', () => {
    expect(cases.length).toBeGreaterThanOrEqual(55);

    const validAgents = new Set([
      ...mockAgents.map((a) => a.id),
      'clarify',
    ]);
    for (const c of cases) {
      expect(validAgents.has(c.expectedAgent)).toBe(true);
    }
  });

  it('at least 10 scribe, 8 seeker, 8 sorter, 5 architect, 5 connector, 5 librarian, 5 scout cases exist', () => {
    const counts: Record<string, number> = {};
    for (const c of cases) {
      counts[c.expectedAgent] = (counts[c.expectedAgent] ?? 0) + 1;
    }

    expect(counts.scribe).toBeGreaterThanOrEqual(10);
    expect(counts.seeker).toBeGreaterThanOrEqual(8);
    expect(counts.sorter).toBeGreaterThanOrEqual(8);
    expect(counts.architect).toBeGreaterThanOrEqual(5);
    expect(counts.connector).toBeGreaterThanOrEqual(5);
    expect(counts.librarian).toBeGreaterThanOrEqual(5);
    expect(counts.scout).toBeGreaterThanOrEqual(5);
  });

  it('includes ambiguous clarify cases', () => {
    const clarifyCount = cases.filter((c) => c.expectedAgent === 'clarify').length;
    expect(clarifyCount).toBeGreaterThanOrEqual(3);
  });
});
