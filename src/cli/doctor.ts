import { loadConfig, getVaultPath } from '../config.js';
import { getLogger } from '../observability/logger.js';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, version as nodeVersion } from 'node:process';
import { get as httpGet } from 'node:http';
import { execFileSync } from 'node:child_process';

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

function checkProxy(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/models', baseUrl);
    const req = httpGet(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: 5000,
      },
      (res) => {
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push({
    label: 'Node.js',
    pass: true,
    detail: `v${nodeVersion} on ${platform}`,
  });

  let config;
  try {
    config = loadConfig();
    results.push({ label: 'Configuration', pass: true, detail: 'Loaded' });
  } catch (err) {
    results.push({
      label: 'Configuration',
      pass: false,
      detail: String(err),
    });
    return results;
  }

  const vaultPath = getVaultPath(config);
  const vaultExists = existsSync(vaultPath);
  results.push({
    label: 'Vault exists',
    pass: vaultExists,
    detail: vaultExists ? vaultPath : `Not found: ${vaultPath}`,
  });

  if (vaultExists) {
    const isDir = statSync(vaultPath).isDirectory();
    results.push({
      label: 'Vault is directory',
      pass: isDir,
      detail: isDir ? 'Yes' : 'Not a directory',
    });

    let canRead = false;
    let canWrite = false;
    try {
      accessSync(vaultPath, constants.R_OK);
      canRead = true;
    } catch {
      /* */
    }
    try {
      accessSync(vaultPath, constants.W_OK);
      canWrite = true;
    } catch {
      /* */
    }
    results.push({
      label: 'Vault readable',
      pass: canRead,
      detail: canRead ? 'Yes' : 'No read permission',
    });
    results.push({
      label: 'Vault writable',
      pass: canWrite,
      detail: canWrite ? 'Yes' : 'No write permission',
    });
  }

  try {
    const reachable = await checkProxy(config.proxyBaseUrl);
    results.push({
      label: 'CommandCode proxy',
      pass: reachable,
      detail: reachable ? config.proxyBaseUrl : `${config.proxyBaseUrl} (unreachable)`,
    });
  } catch {
    results.push({
      label: 'CommandCode proxy',
      pass: false,
      detail: `Cannot reach ${config.proxyBaseUrl}`,
    });
  }

  const dbPath = resolve(config.databasePath);
  const dbDir = resolve(dbPath, '..');
  try {
    accessSync(dbDir, constants.W_OK);
    results.push({
      label: 'Database directory writable',
      pass: true,
      detail: dbDir,
    });
  } catch {
    results.push({
      label: 'Database directory writable',
      pass: false,
      detail: `Cannot write to ${dbDir}`,
    });
  }

  // Vault hygiene enforcement (V1-V4) — Issues & Learnings Enforcement Layer 3.
  // Warn-level findings still exit 0 (pass); a non-zero exit means real errors.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const enforcementScript = resolve(repoRoot, 'scripts', 'check-vault-enforcement.ts');
  if (existsSync(enforcementScript)) {
    try {
      // Invoke tsx via node directly — spawning `npx` from inside a tsx process
      // can fail with ELOOP on macOS.
      const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const stdout = execFileSync(process.execPath, [tsxCli, enforcementScript, '--full'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      // Parse the machine-readable ENFORCEMENT_FINDINGS=<n> line the script emits,
      // instead of scraping human prose ("N warning(s)") which was brittle. The
      // human summary line is still shown as the detail.
      const findingsLine = lines.find((l) => /^ENFORCEMENT_FINDINGS=\d+$/.test(l));
      const findings = findingsLine ? Number(findingsLine.split('=')[1]) : NaN;
      const summary =
        lines.filter((l) => !l.startsWith('ENFORCEMENT_FINDINGS=')).pop() ?? 'Clean';
      const hasFindings = Number.isFinite(findings) && findings > 0;
      results.push({
        label: 'Vault enforcement (V1-V4)',
        pass: true,
        detail: hasFindings ? `${findings} finding(s) — ${summary}` : summary,
      });
    } catch (err) {
      const stdout =
        err instanceof Error && 'stdout' in err ? String((err as any).stdout ?? '') : '';
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      results.push({
        label: 'Vault enforcement (V1-V4)',
        pass: false,
        detail: lines[lines.length - 1] ?? String(err),
      });
    }
  } else {
    results.push({
      label: 'Vault enforcement (V1-V4)',
      pass: false,
      detail: `Script not found: ${enforcementScript}`,
    });
  }

  // Enforcement code guards (C1-C3) + verification suite — Layer 3B. These are the
  // vitest guards that prove the incident-001/002 fixes still hold. crew doctor runs
  // them so a broken guard surfaces here, not just in CI (deliverable 3e).
  const enforcementTest = resolve(repoRoot, 'tests', 'enforcement.test.ts');
  if (existsSync(enforcementTest)) {
    try {
      // Invoke vitest via node directly (same reason as above — avoid npx from
      // inside a spawned process). `vitest run <file>` exits non-zero on failure.
      const vitestCli = resolve(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
      execFileSync(process.execPath, [vitestCli, 'run', enforcementTest], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      });
      results.push({
        label: 'Enforcement guards (C1-C3 + verification)',
        pass: true,
        detail: 'All enforcement guards pass',
      });
    } catch (err) {
      const stdout =
        err instanceof Error && 'stdout' in err ? String((err as any).stdout ?? '') : '';
      const failLine =
        stdout.split(/\r?\n/).reverse().find((l) => /Tests\s+\d+\s+failed/.test(l)) ??
        'enforcement guard(s) failed';
      results.push({
        label: 'Enforcement guards (C1-C3 + verification)',
        pass: false,
        detail: failLine.trim(),
      });
    }
  }

  return results;
}

export function printDoctorResults(results: CheckResult[]): void {
  const logger = getLogger();
  let passCount = 0;
  let failCount = 0;

  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    logger.info(`${icon} ${r.label}: ${r.detail}`);
    if (r.pass) passCount++;
    else failCount++;
  }

  logger.info('');
  logger.info(
    `Results: ${passCount} passed, ${failCount} failed, ${results.length} total`,
  );

  if (failCount > 0) {
    process.exitCode = 1;
  }
}
