// Per-flow metric templates for the Eval tab.
// Each template is a scoring function string that the user can edit inline.

export interface MetricTemplate {
  /** Unique key matching the flow id. */
  flowId: string;
  /** Human-readable label shown in the template selector. */
  label: string;
  /** Default metric function body — receives (output, expected) and returns 0–1. */
  metric: string;
  /** What output fields this metric checks. */
  checks: string[];
}

export const METRIC_TEMPLATES: MetricTemplate[] = [
  {
    flowId: 'braindump-triage',
    label: 'Braindump Triage — item count + confidence',
    metric: `function score(output, expected) {
  // Check item count matches
  const countOk = output.itemCount === expected.itemCount;
  // Check no orphaned slugs (unexpected items without notes)
  const noOrphans = !output.warnings || !output.warnings.some(w => w.includes('orphan'));
  return countOk && noOrphans ? 1 : countOk ? 0.5 : 0;
}`,
    checks: ['itemCount', 'warnings'],
  },
  {
    flowId: 'deep-clean',
    label: 'Deep Clean — fix report produced',
    metric: `function score(output, expected) {
  // Check a report was written (or dry-run previewed)
  const reportProduced = output.reportWritten === expected.reportWritten;
  // Check notes flagged for fixes exist
  const notesFlagged = Array.isArray(output.notesToFix) && output.notesToFix.length > 0;
  return reportProduced ? (notesFlagged ? 1 : 0.7) : 0;
}`,
    checks: ['reportWritten', 'notesToFix'],
  },
  {
    flowId: 'defrag',
    label: 'Defrag — actionable cleanup results',
    metric: `function score(output, expected) {
  // Inbox items handled or orphan notes linked
  const madeProgress = (output.inboxMoved > 0) || (output.orphansLinked > 0);
  // Report was written
  const reportOk = output.reportWritten === expected.reportWritten;
  return madeProgress && reportOk ? 1 : reportOk ? 0.5 : 0;
}`,
    checks: ['inboxMoved', 'orphansLinked', 'reportWritten'],
  },
  {
    flowId: 'prior-art',
    label: 'Prior Art — discovery completed with results',
    metric: `function score(output, expected) {
  // Discovery ran with at least one source checked
  const looked = output.discovery && output.discovery.totalMatches !== undefined;
  // At least one deep dive recommendation is USE or EVALUATE
  const hasRecommendation = Array.isArray(output.deepDives) &&
    output.deepDives.some(d => d.recommendation === 'USE' || d.recommendation === 'EVALUATE');
  return looked && hasRecommendation ? 1 : looked ? 0.5 : 0;
}`,
    checks: ['discovery.totalMatches', 'deepDives'],
  },
  {
    flowId: 'project-scaffold',
    label: 'Project Scaffold — project + phases created',
    metric: `function score(output, expected) {
  // Project file written
  const hasProject = typeof output.project === 'string' && output.project.length > 0;
  // Phases exist
  const hasPhases = Array.isArray(output.phases) && output.phases.length > 0;
  return hasProject && hasPhases ? 1 : hasProject ? 0.5 : 0;
}`,
    checks: ['project', 'phases'],
  },
  {
    flowId: 'tag-garden',
    label: 'Tag Garden — renames proposed, report written',
    metric: `function score(output, expected) {
  // Report written
  const reportOk = output.reportWritten === expected.reportWritten;
  // Renames proposed or no duplicates found (both are valid outcomes)
  const hasRenames = Array.isArray(output.proposedRenames) && output.proposedRenames.length > 0;
  const noDuplicates = output.nearDuplicateGroupCount === 0;
  return reportOk ? 1 : (hasRenames || noDuplicates) ? 0.5 : 0;
}`,
    checks: ['reportWritten', 'proposedRenames', 'nearDuplicateGroupCount'],
  },
  {
    flowId: 'triage-route',
    label: 'Triage Route — items classified + routed',
    metric: `function score(output, expected) {
  // Items were routed (or confirmed already routed)
  const madeProgress = (output.routedCount > 0) || (output.alreadyRouted > 0);
  // No errors in routing
  const noUnrouted = output.unroutedCount === 0;
  return madeProgress && noUnrouted ? 1 : madeProgress ? 0.6 : 0;
}`,
    checks: ['routedCount', 'alreadyRouted', 'unroutedCount'],
  },
  {
    flowId: 'vault-assess',
    label: 'Vault Assess — quality scores + strengths',
    metric: `function score(output, expected) {
  // Assessment produced
  const scored = typeof output.aiFriendlyScore === 'number' && output.aiFriendlyScore > 0;
  // Strengths / weaknesses surfaced
  const hasObservations = (Array.isArray(output.strengths) && output.strengths.length > 0) ||
    (Array.isArray(output.weaknesses) && output.weaknesses.length > 0);
  return scored && hasObservations ? 1 : scored ? 0.6 : 0;
}`,
    checks: ['aiFriendlyScore', 'strengths', 'weaknesses'],
  },
  {
    flowId: 'vault-audit',
    label: 'Vault Audit — health score + report',
    metric: `function score(output, expected) {
  // Health score produced
  const scored = typeof output.healthScore === 'number';
  // Report written
  const reportOk = output.reportWritten === expected.reportWritten;
  return scored && reportOk ? 1 : scored ? 0.6 : 0;
}`,
    checks: ['healthScore', 'reportWritten'],
  },
];

export function getMetricTemplate(flowId: string): MetricTemplate | undefined {
  return METRIC_TEMPLATES.find((t) => t.flowId === flowId);
}
