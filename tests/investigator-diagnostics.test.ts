import { describe, it, expect } from 'vitest';
import { codeRead, CodeReadError } from '../src/tools/code-read.js';

// These cover the read-only diagnostic tools granted to the Investigator so it
// can trace failures instead of speculating. crew.listRuns / crew.getRun are
// exercised end-to-end in the smoke script against the live DB; here we lock
// down code.read's guards, which are the security-sensitive part.

describe('code.read guards', () => {
  it('reads a repo source file', () => {
    const out = codeRead({ path: 'src/tools/code-read.ts', maxChars: 500 });
    expect(out.path).toBe('src/tools/code-read.ts');
    expect(out.content.length).toBeGreaterThan(0);
    expect(out.size).toBeGreaterThan(0);
  });

  it('truncates at maxChars', () => {
    const out = codeRead({ path: 'src/runtime/executor.ts', maxChars: 500 });
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('[truncated');
  });

  it('blocks path traversal out of the repo', () => {
    expect(() => codeRead({ path: '../../../etc/passwd' })).toThrow(
      CodeReadError,
    );
  });

  it('blocks absolute paths', () => {
    expect(() => codeRead({ path: '/etc/passwd' })).toThrow(CodeReadError);
  });

  it('denies secret files', () => {
    expect(() => codeRead({ path: '.env' })).toThrow(/secrets/i);
    expect(() => codeRead({ path: 'config/app.pem' })).toThrow(/secrets/i);
  });

  it('reports a clear error for a missing file', () => {
    expect(() => codeRead({ path: 'src/tools/does-not-exist.ts' })).toThrow(
      /not found/i,
    );
  });
});
