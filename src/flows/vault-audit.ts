import { flow } from '@ax-llm/ax';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import { vaultWrite } from '../tools/vault-write.js';
import { scanVault } from '../tools/vault-scan.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E2 — vault-audit as an ax-native flow() (copies the E1 deep-clean pattern).
//
// Pipeline (from crew/skills/vault-audit.md):
//
//   runScan (.map, deterministic, no LLM)  — scanVault() covers frontmatter,
//                                             broken links, stale/orphans
//   summarizeObservations (ax() node)      — LLM adds folder-convention +
//                                             tag-quality judgment calls that
//                                             scanVault doesn't cover (a
//                                             lightweight, read-only note, not
//                                             a rewrite of the scan's findings)
//   writeReport (.map, deterministic I/O)  — Meta/health-reports/vault-audit-<date>.md
//   .returns(...)
//
// This flow is READ-ONLY except for the report write itself, which is the
// audit's own output artifact (not a vault content change) — still threaded
// through dryRun for consistency with every other write in the crew, and so a
// dry-run audit previews its report path without touching disk.
//
// No agent ever runs in this flow (Design A, same as deep-clean) — the only
// LLM step is a single typed ax() signature node with no tools at all, so
// there is no tool-calling reliability risk to begin with.
// ---------------------------------------------------------------------------

// NOTE: ax v23's signature validator rejects generic field names (status,
// response, request, data, ...) — same fix as E1's deep-clean. Field names
// here are deliberately descriptive (userRequest, dryRunMode, sessionRunId,
// scanReportMarkdown, folderAndTagObservations).
export interface VaultAuditInput extends Record<string, any> {
  userRequest: string;
  dryRunMode: boolean;
  sessionRunId?: string;
}

export interface VaultAuditOutput extends Record<string, unknown> {
  totalNotes: number;
  issueCount: number;
  healthScore: number;
  folderAndTagObservations: string;
  reportPath: string;
  reportWritten: boolean;
  response: string;
  warnings: string[];
}

const HEALTH_REPORTS_DIR = 'Meta/health-reports';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildVaultAuditFlow() {
  return (
    flow<VaultAuditInput, VaultAuditOutput>()
      // Native ax() node — folder-convention + tag-quality judgment calls that
      // scanVault() doesn't cover (mechanical checks only: frontmatter, links,
      // freshness). Read-only, no tools — nothing here can write to the vault.
      .node(
        'summarizeObservations',
        'scanReportMarkdown:string, userRequest:string -> folderAndTagObservations:string "brief notes on folder-convention adherence (do notes live in folders matching their type field?) and tag-quality (near-duplicate or overly generic tags) inferred from the scan findings; say so plainly if the scan text has too little detail to judge either"',
      )

      // 1) Deterministic scan (no LLM) — mechanical checks run in milliseconds.
      .map((state) => {
        const scan = scanVault();
        return {
          ...state,
          scanReportMarkdown: scan.reportMarkdown,
          totalNotes: scan.totalNotes,
          issueCount: scan.issues.length,
          healthScore: scan.healthScore,
          warnings: [] as string[],
        };
      })

      // 2) LLM adds folder-convention + tag-quality observations on top of the
      //    scan (judgment calls the deterministic scan doesn't attempt).
      .execute('summarizeObservations', (state) => ({
        scanReportMarkdown: state.scanReportMarkdown,
        userRequest: state.userRequest,
      }))
      .map((state) => ({
        ...state,
        folderAndTagObservations:
          state.summarizeObservationsResult?.folderAndTagObservations ?? '',
      }))

      // 3) Write the audit report (dryRun-aware; the report itself is the only
      //    write this flow ever makes).
      .map((state) => {
        const reportPath = `${HEALTH_REPORTS_DIR}/vault-audit-${today()}.md`;
        const body =
          `---\n` +
          `date: ${today()}\n` +
          `type: reference\n` +
          `tags:\n  - system\n  - vault-health\n` +
          `ai-first: true\n` +
          `---\n\n` +
          `# Vault Audit — ${today()}\n\n` +
          `${state.scanReportMarkdown}\n\n` +
          `## Folder conventions & tag quality (judgment)\n${state.folderAndTagObservations}\n`;
        const write = vaultWrite({
          path: reportPath,
          content: body,
          overwrite: true,
          dryRun: state.dryRunMode,
        });
        return {
          ...state,
          reportPath: write.path,
          reportWritten: write.operation === 'created',
        };
      })

      .returns((state) => ({
        totalNotes: state.totalNotes,
        issueCount: state.issueCount,
        healthScore: state.healthScore,
        folderAndTagObservations: state.folderAndTagObservations,
        reportPath: state.reportPath,
        reportWritten: state.reportWritten,
        response:
          `Vault audit — ${state.totalNotes} note(s) scanned, ${state.issueCount} issue(s), ` +
          `health score ${state.healthScore}/100.\n\n${state.folderAndTagObservations}`,
        warnings: state.warnings,
      }))
  );
}

export interface RunVaultAuditFlowResult {
  output: VaultAuditOutput;
  finalResponse: string;
}

export async function runVaultAuditFlow(args: {
  request: string;
  dryRun: boolean;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunVaultAuditFlowResult> {
  const logger = getLogger();
  const wf = buildVaultAuditFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.vault-audit');

  logger.info({ runId: args.runId, dryRun: args.dryRun }, 'vault-audit flow started');

  const output = (await wf.forward(
    llm,
    {
      userRequest: args.request,
      dryRunMode: args.dryRun,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as VaultAuditOutput;

  logger.info(
    {
      runId: args.runId,
      totalNotes: output.totalNotes,
      issueCount: output.issueCount,
      healthScore: output.healthScore,
      reportWritten: output.reportWritten,
    },
    'vault-audit flow completed',
  );

  const dryNote = args.dryRun
    ? `\n\n---\n**Approval required.** "Vault Audit" writes a report to your vault, so ` +
      `this was a plan only — nothing was written (report path preview: ` +
      `${output.reportPath}). Reply "proceed" (or "yes, go ahead") to run it for real.`
    : '';

  return {
    output,
    finalResponse: `${output.response}${dryNote}`,
  };
}

registerFlow({
  id: 'vault-audit',
  name: 'Vault Audit',
  description: 'Full vault health assessment. Audits frontmatter, finds broken links, detects stale notes, checks folder conventions.',
  triggers: ['audit my vault', 'vault audit', 'check vault health', 'vault health report', 'run a health check'],
  approvalRequired: true,
  sourceFile: 'src/flows/vault-audit.ts',
  run: async (args) => runVaultAuditFlow({ request: args.request, dryRun: args.dryRun ?? false, runId: args.runId }),
});
