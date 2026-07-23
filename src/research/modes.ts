/**
 * Research modes — typed instruction sets that plug into the `research`
 * lifecycle (frame → gather → synthesize → verify). Each mode changes
 * the per-phase behavior: same pipeline, different approach.
 *
 * Defined 2026-07-21 from Ben's actual research patterns across vault
 * projects + 200+ agentmemory sessions. See:
 *   - MOC/Workflow Registry.md — "Research modes" table
 *   - Projects/better-research.md — approach + examples
 *   - vault/Templates/tpl-triage-buttons.md — mode selector
 */

export interface ResearchMode {
  /** Unique id matching the frontmatter research_mode value. */
  id: string;
  /** Human-readable label for dropdowns/logging. */
  label: string;
  /** Short description shown in tooltips. */
  description: string;
  /** Phase-level instruction overrides. Each is prepended to the
   * standard phase prompt for the research lifecycle. */
  hints: {
    /** Framing: how to set up the question before any search. */
    frame: string;
    /** Gathering: what kind of sources to seek, how to evaluate them. */
    gather: string;
    /** Synthesis: how to structure findings and what patterns to look for. */
    synthesize: string;
    /** Verification: what counts as "done" for this mode. */
    verify: string;
  };
}

/**
 * Canonical research modes. Add a new entry here, then register it in:
 *   1. MOC/Workflow Registry.md — add a row to the Research modes table
 *   2. Templates/tpl-triage-buttons.md — add an option to the dropdown
 *   3. scripts/process-triage-requests.ts — modeHint already handles any value
 */
export const RESEARCH_MODES: Record<string, ResearchMode> = {
  'first-principles': {
    id: 'first-principles',
    label: 'First Principles',
    description: 'Break claims down to axioms, build up from fundamentals.',
    hints: {
      frame:
        'First Principles mode: before accepting any claim, ask "what assumptions is this built on?" ' +
        'Identify 3-5 axioms the argument depends on. State the question in terms of what is ' +
        'actually true, not what is commonly believed. Strip away analogy, convention, and ' +
        'received wisdom. What remains? Frame the investigation around those fundamentals.',
      gather:
        'Gather primary sources and foundational material, not conclusions drawn by others. ' +
        'Seek the raw evidence, data, or original arguments. Avoid synthesis pieces, summaries, ' +
        'and "what experts think." Look for the building blocks: definitions, experiments, ' +
        'original formulations, counterexamples.',
      synthesize:
        'Build up from the axioms you identified. For each claim, trace the chain from axiom ' +
        'to conclusion. Flag any leap that is not fully supported. Where evidence is thin, say so. ' +
        'Where a conventional view rests on an unexamined assumption, call it out. ' +
        'Confidence tags: [HIGH] only when the chain from axiom to conclusion is complete.',
      verify:
        'Every axiom must be cited to a primary source. Every "this implies that" step must ' +
        'withstand "does it necessarily follow?" Check for hidden assumptions in each conclusion. ' +
        'If a claim cannot be reduced to fundamentals, mark it [CONFLICT] or downgrade confidence.',
    },
  },

  'adversarial-review': {
    id: 'adversarial-review',
    label: 'Adversarial Review',
    description: 'Actively look for flaws, contradictions, and counterexamples.',
    hints: {
      frame:
        'Adversarial Review mode: state the exact claim or output being reviewed. Define what would ' +
        'DISPROVE it — what evidence or counterexample would it fail? Set the bar: are we checking ' +
        'for fatal flaws, or just scoring confidence? If reviewing agent output, state what the ' +
        'agent was asked to do and what it actually produced.',
      gather:
        'Actively seek contradictory sources. Look for counterexamples, opposing viewpoints, ' +
        'alternative explanations, and edge cases the claim did not consider. If the claim is ' +
        'quantitative, gather competing data. If qualitative, gather experts who disagree. ' +
        'Do not just collect evidence that supports the claim.',
      synthesize:
        'Score every component of the claim independently. Highlight the weakest points — ' +
        'where evidence is missing, reasoning is flawed, or alternatives are stronger. ' +
        'Structure as: what holds up, what doesn\'t, what\'s uncertain, and what\'s wrong. ' +
        'Confidence tags: use [LOW] liberally; save [HIGH] for ironclad points.',
      verify:
        'Every counterexample must be real and checkable. Every "this is wrong" must cite ' +
        'specific evidence or reasoning. If the claim is agent output, verify tools were called ' +
        'correctly, files read/written were appropriate, and the output matches the request. ' +
        'If nothing is wrong, say so — adversarial review is honest, not performative.',
    },
  },

  'knowledge-base': {
    id: 'knowledge-base',
    label: 'Knowledge Base',
    description: 'Structured collection → MOC + concept notes with confidence tags.',
    hints: {
      frame:
        'Knowledge Base mode: define the domain and the spine (organizing principle). What ' +
        'angle makes this collection useful? What\'s the scope boundary — what is IN and what ' +
        'is NOT? Name the MOC structure: what concept notes will exist, and how they relate. ' +
        'Pattern: follow [[behavioral-econ-kb]] and [[jordan-peterson-kb]].',
      gather:
        'Cast a broad net across primary and secondary sources. For each concept note slot, ' +
        'collect multiple sources. Prioritize original works (books, papers, lectures) over ' +
        'summaries. Note where multiple credible sources converge and where they diverge. ' +
        'Save everything with source citations.',
      synthesize:
        'Write one MOC note + one concept note per topic. Each note: frontmatter with ' +
        'ai-first:true + tags, "For future agents" section, backlink to MOC. Tag claims ' +
        'with [HIGH]/[MED]/[LOW]/[CONFLICT]. Every note must resolve all internal wiki-links. ' +
        'Pattern matches Behavioral Econ KB and Jordan Peterson KB exactly.',
      verify:
        'Every concept note must have: working frontmatter, "For future agents" section, ' +
        'backlink to MOC, resolution of all [[links]]. Every cited source must be real and ' +
        'accessible. Every confidence tag must be justified by source quality or convergence. ' +
        'MOC must link to every concept note and every concept note must link back.',
    },
  },

  diagnostic: {
    id: 'diagnostic',
    label: 'Diagnostic',
    description: 'Trace a symptom to its root cause.',
    hints: {
      frame:
        'Diagnostic mode: define the symptom precisely — what is happening that should not? ' +
        'Define the system boundary — what components are involved? What is the "normal" state ' +
        'that this diverges from? When did it start? What changed around that time? ' +
        'Pattern: follow [[Meta/incident-workflow]] (reproduce → evidence → delta → isolate).',
      gather:
        'Collect logs, traces, error messages, timestamps, and any observable evidence. ' +
        'Compare working vs. failing states. Identify what changed: code, config, data, ' +
        'dependencies, environment. If possible, reproduce the failure. If not, gather ' +
        'every available signal. Interview agentmemory sessions for similar failures.',
      synthesize:
        'Build a failure chain: symptom → immediate cause → underlying condition → root cause. ' +
        'Each link in the chain must be supported by evidence. Propose the fix that addresses ' +
        'the ROOT cause, not just the symptom. If multiple causes exist, rank them. ' +
        'If a cause is speculative, label it as such.',
      verify:
        'Confirm every link in the failure chain with evidence. Propose a guard (code, not ' +
        'a prompt — per [[issues-learnings-enforcement]] design principle 1: "instructions ' +
        'are ~0% reliable — every guard must be code"). If the fix is applied, verify it ' +
        'would have prevented the original failure (counterfactual test).',
    },
  },
};

/** Validate a mode id. Returns null for unknown modes. */
export function resolveMode(modeId: string): ResearchMode | null {
  const clean = String(modeId ?? '').trim().toLowerCase();
  return RESEARCH_MODES[clean] ?? null;
}

/** Build a prompt suffix for a given mode. Returns empty string if unknown. */
export function modePromptHint(modeId: string): string {
  const mode = resolveMode(modeId);
  if (!mode) return '';
  return [
    `\nResearch mode: ${mode.label}`,
    `Frame: ${mode.hints.frame}`,
    `Gather: ${mode.hints.gather}`,
    `Synthesize: ${mode.hints.synthesize}`,
    `Verify: ${mode.hints.verify}`,
  ].join('\n');
}

/** Produce a summary of available modes (for LLM context / workflow registry). */
export function describeModes(): string {
  return Object.values(RESEARCH_MODES)
    .map((m) => `${m.id} — ${m.label}: ${m.description}`)
    .join('\n');
}
