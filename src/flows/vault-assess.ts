import { flow } from '@ax-llm/ax';
import { trace, type Tracer } from '@opentelemetry/api';
import { createModelClient } from '../ai/clients.js';
import {
  externalList,
  externalRead,
  isExternalVaultConfigured,
} from '../tools/external-vault.js';
import { getLogger } from '../observability/logger.js';
import { registerFlow } from './registry.js';

// ---------------------------------------------------------------------------
// E2 — vault-assess as an ax-native flow(). Read-only (no dryRun/write
// concern at all — this flow never touches vaultWrite/vaultMove/
// vaultUpdateFrontmatter), so it is lower risk than the write-bearing skills.
//
// Pipeline (from crew/skills/vault-assess.md):
//
//   surveyExternalVault (.map, deterministic I/O)  — externalList() the top
//     level + each major folder, externalRead() a representative sample of
//     notes, all via the ext.* surface (external-vault.ts), NOT vault.*
//   assessVault (ax() node)                        — the genuinely qualitative
//     judgment call ("what should I port", structure/quality/AI-friendliness
//     scoring) — this needs semantic judgment, so it stays an LLM node
//   .returns(...)
//
// No agent runs here either — the survey is deterministic, and the assessment
// itself is a single typed signature node with no tools (nothing to misuse).
// ---------------------------------------------------------------------------

export interface VaultAssessInput extends Record<string, any> {
  userRequest: string;
  sessionRunId?: string;
}

export interface VaultAssessOutput extends Record<string, unknown> {
  configured: boolean;
  totalNotesSampled: number;
  topLevelFolders: string[];
  narrativeAssessment: string;
  elevatorPitch: string;
  aiFriendlyScore: number;
  qualityScore: number;
  strengths: string[];
  weaknesses: string[];
  notableNotePaths: string[];
  response: string;
  warnings: string[];
}

const MAX_FOLDERS_TO_SAMPLE = 8;
const MAX_NOTES_PER_FOLDER = 3;
const EXCERPT_LENGTH = 600;

interface SampledNote {
  path: string;
  excerpt: string;
}

/**
 * Deterministic survey of the external vault — top-level listing, then a
 * bounded sample of notes from each top-level folder. No judgment here, just
 * mechanical listing/reading via the ext.* tool surface.
 */
function surveyExternalVault(): {
  topLevelFolders: string[];
  sampledNotes: SampledNote[];
  totalNotesSampled: number;
} {
  const top = externalList('.');
  if (!top) {
    return { topLevelFolders: [], sampledNotes: [], totalNotesSampled: 0 };
  }

  const topLevelFolders = top.items
    .filter((i) => i.type === 'directory')
    .map((i) => i.name);

  const sampledNotes: SampledNote[] = [];

  const sampleFrom = (dirPath: string, remaining: number): void => {
    const listing = externalList(dirPath);
    if (!listing) return;
    for (const item of listing.items) {
      if (remaining <= 0) return;
      if (item.type === 'file' && item.name.endsWith('.md')) {
        const read = externalRead(item.path);
        if (read) {
          sampledNotes.push({
            path: read.path,
            excerpt: read.content.slice(0, EXCERPT_LENGTH),
          });
          remaining--;
        }
      }
    }
  };

  // Sample a few top-level files directly.
  const topFiles = top.items.filter((i) => i.type === 'file' && i.name.endsWith('.md'));
  for (const f of topFiles.slice(0, MAX_NOTES_PER_FOLDER)) {
    const read = externalRead(f.path);
    if (read) sampledNotes.push({ path: read.path, excerpt: read.content.slice(0, EXCERPT_LENGTH) });
  }

  for (const folder of topLevelFolders.slice(0, MAX_FOLDERS_TO_SAMPLE)) {
    sampleFrom(folder, MAX_NOTES_PER_FOLDER);
  }

  return { topLevelFolders, sampledNotes, totalNotesSampled: sampledNotes.length };
}

export function buildVaultAssessFlow() {
  return (
    flow<VaultAssessInput, VaultAssessOutput>()
      // The one genuine judgment call: everything the skill doc asks for that
      // isn't mechanical — structure/content/quality/AI-friendliness scoring,
      // strengths/weaknesses/gaps, and what's worth porting. Read-only, no tools.
      .node(
        'assessVault',
        'topLevelFolders:string[], sampledExcerpts:string, userRequest:string -> narrativeAssessment:string "a paragraph or two summarizing what the vault is, its strengths and weaknesses", elevatorPitch:string "one-sentence summary", aiFriendlyScore:number "0-100, how easy would an LLM agent find this vault to navigate", qualityScore:number "0-100, overall content quality", strengths:string[], weaknesses:string[], notableNotePaths:string[] "paths from the sampled excerpts worth highlighting"',
      )

      // 1) Deterministic survey (no LLM) — ext.* tools only, per the skill's
      //    read-only ext.* surface (not vault.*).
      .map((state) => {
        if (!isExternalVaultConfigured()) {
          return {
            ...state,
            configured: false,
            topLevelFolders: [] as string[],
            sampledNotes: [] as SampledNote[],
            totalNotesSampled: 0,
            warnings: [
              'External vault not configured. Set EXTERNAL_VAULT_PATH in .env.',
            ],
          };
        }
        const survey = surveyExternalVault();
        return {
          ...state,
          configured: true,
          topLevelFolders: survey.topLevelFolders,
          sampledNotes: survey.sampledNotes,
          totalNotesSampled: survey.totalNotesSampled,
          warnings: [] as string[],
        };
      })

      // 2) LLM assessment — skip entirely when there's nothing to assess.
      .branch((state) => state.configured && state.sampledNotes.length > 0)
        .when(true)
          .execute('assessVault', (state) => ({
            topLevelFolders: state.topLevelFolders,
            sampledExcerpts: state.sampledNotes
              .map((n: SampledNote) => `### ${n.path}\n${n.excerpt}`)
              .join('\n\n'),
            userRequest: state.userRequest,
          }))
          .map((state) => ({
            ...state,
            narrativeAssessment: state.assessVaultResult?.narrativeAssessment ?? '',
            elevatorPitch: state.assessVaultResult?.elevatorPitch ?? '',
            aiFriendlyScore: state.assessVaultResult?.aiFriendlyScore ?? 0,
            qualityScore: state.assessVaultResult?.qualityScore ?? 0,
            strengths: state.assessVaultResult?.strengths ?? [],
            weaknesses: state.assessVaultResult?.weaknesses ?? [],
            notableNotePaths: state.assessVaultResult?.notableNotePaths ?? [],
          }))
        .when(false)
          .map((state) => ({
            ...state,
            narrativeAssessment: state.configured
              ? 'No markdown notes found to sample — nothing to assess.'
              : 'External vault not configured.',
            elevatorPitch: state.configured ? 'Empty or unreadable external vault.' : 'Not configured.',
            aiFriendlyScore: 0,
            qualityScore: 0,
            strengths: [] as string[],
            weaknesses: [] as string[],
            notableNotePaths: [] as string[],
          }))
      .merge()

      .returns((state) => ({
        configured: state.configured,
        totalNotesSampled: state.totalNotesSampled,
        topLevelFolders: state.topLevelFolders,
        narrativeAssessment: state.narrativeAssessment,
        elevatorPitch: state.elevatorPitch,
        aiFriendlyScore: state.aiFriendlyScore,
        qualityScore: state.qualityScore,
        strengths: state.strengths,
        weaknesses: state.weaknesses,
        notableNotePaths: state.notableNotePaths,
        response: `${state.elevatorPitch}\n\n${state.narrativeAssessment}`,
        warnings: state.warnings,
      }))
  );
}

export interface RunVaultAssessFlowResult {
  output: VaultAssessOutput;
  finalResponse: string;
}

/**
 * Run the vault-assess flow. Read-only — no dryRun parameter at all, since
 * this flow has no write path (ext.* tools are read-only by construction, and
 * this flow adds none of its own).
 */
export async function runVaultAssessFlow(args: {
  request: string;
  runId?: string;
  tracer?: Tracer;
}): Promise<RunVaultAssessFlowResult> {
  const logger = getLogger();
  const wf = buildVaultAssessFlow();
  const llm = createModelClient('fast');
  const tracer = args.tracer ?? trace.getTracer('ax-brain-crew.vault-assess');

  logger.info({ runId: args.runId }, 'vault-assess flow started');

  const output = (await wf.forward(
    llm,
    {
      userRequest: args.request,
      sessionRunId: args.runId,
    },
    { tracer },
  )) as VaultAssessOutput;

  logger.info(
    {
      runId: args.runId,
      configured: output.configured,
      totalNotesSampled: output.totalNotesSampled,
      aiFriendlyScore: output.aiFriendlyScore,
    },
    'vault-assess flow completed',
  );

  return {
    output,
    finalResponse: output.response,
  };
}

registerFlow({
  id: 'vault-assess',
  name: 'Vault Assessment',
  description: 'Thorough read-only audit of an external vault. Surveys structure, content themes, quality, and AI-friendliness.',
  triggers: ['assess my vault', 'evaluate my vault', 'what should I port', 'what should I migrate', 'audit my external vault', 'review my vault for migration', 'survey my vault'],
  approvalRequired: false,
  sourceFile: 'src/flows/vault-assess.ts',
  run: async (args) => runVaultAssessFlow({ request: args.request, runId: args.runId }),
});
