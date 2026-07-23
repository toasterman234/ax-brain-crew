#!/usr/bin/env tsx
import { Command } from 'commander';
import { resolve } from 'node:path';
import { initializeRuntime } from '../runtime/init.js';
import { runDoctor, printDoctorResults } from './doctor.js';
import { runSmokeTest } from './smoke-test.js';
import {
  loadRegistry,
  getAllAgents,
  resetRegistry,
} from '../registry/registry.js';
import { normalizeRequest } from '../routing/normalize.js';
import { classifyRequest } from '../routing/agent-router.js';
import { enforcePolicy } from '../routing/routing-policy.js';
import { dispatch } from '../runtime/dispatcher.js';
import { TOOL_REGISTRY } from '../tools/index.js';
import { getConfig } from '../config.js';
import { getDb, finalizeRun } from '../persistence/database.js';
import { loadSkillsRegistry } from '../skills/executor.js';
import { runChat } from './chat.js';
import { runServe } from './serve.js';
import { runWorker } from './worker.js';
import {
  summarizeObservations,
  type ContextSummarizationInput,
  type Observation,
} from '../tools/session-summarize.js';
import {
  loadOnboardingState,
  saveOnboardingState,
  createFreshState,
  applyAnswer,
  clearOnboardingState,
  isVaultInitialized,
} from '../onboarding/state.js';
import {
  askNextQuestion,
  createVaultFromAnswers,
} from '../onboarding/engine.js';
import * as readline from 'node:readline/promises';

function ensureRegistry() {
  const registryPath = resolve('crew', 'registry.yaml');
  resetRegistry();
  loadRegistry(registryPath);
  return getAllAgents();
}

function ensureSkills() {
  const skillsPath = resolve('crew', 'skills.yaml');
  loadSkillsRegistry(skillsPath);
}

const program = new Command();

program
  .name('crew')
  .description('Ax Brain Crew — vault-aware specialist agent runtime');

program
  .command('doctor')
  .description('Check environment health')
  .action(async () => {
    const results = await runDoctor();
    printDoctorResults(results);
  });

program
  .command('smoke-test')
  .description('Verify Ax + proxy connectivity')
  .action(async () => {
    const result = await runSmokeTest();
    if (result.pass) {
      console.log(`✅ Smoke test passed: ${result.detail}`);
      console.log(JSON.stringify(result.output, null, 2));
    } else {
      console.error(`❌ Smoke test failed: ${result.detail}`);
      process.exit(1);
    }
  });

program
  .command('agents')
  .description('List registered agents')
  .action(() => {
    try {
      const agents = ensureRegistry();
      console.log('Registered agents:\n');
      for (const a of agents) {
        console.log(`  ${a.name.padEnd(12)} (${a.id})`);
        console.log(
          `    Tier:      ${a.modelTier}`,
        );
        console.log(
          `    Tools:     ${a.allowedTools.map((t) => t.name).join(', ')}`,
        );
        console.log(
          `    Triggers:  ${a.triggers.slice(0, 3).join(', ')}${a.triggers.length > 3 ? '...' : ''}`,
        );
        console.log(
          `    Handoffs:  ${a.handoffs.allowedTargets.join(', ') || 'none'}`,
        );
        console.log();
      }
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }
  });

program
  .command('tools')
  .description('List available tools')
  .action(() => {
    console.log('Available vault tools:\n');
    for (const tool of TOOL_REGISTRY) {
      const level =
        tool.approvalLevel === 0
          ? 'read-only'
          : 'write (dry-run default)';
      console.log(`  ${tool.name.padEnd(28)} ${level}`);
      console.log(`    ${tool.description}`);
    }
  });

program
  .command('ask')
  .description('Submit a natural-language request')
  .argument('<request...>', 'The request to process')
  .action(async (requestParts: string[]) => {
    const request = requestParts.join(' ');
    let agents;
    try {
      agents = ensureRegistry();
      ensureSkills();
      ensureSkills();
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }

    const db = getDb();
    const config = getConfig();

    initializeRuntime();
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO runs (id, started_at, status, original_request)
       VALUES (?, ?, 'started', ?)`,
    ).run(runId, startedAt, request);

    let output;
    try {
      output = await dispatch({ request, agents });
    } catch (err) {
      // dispatch() already catches internally, but never let a thrown run stay
      // 'started' — finalize as failed with the reason, then rethrow to the CLI.
      finalizeRun(runId, { status: 'failed', error: String(err) });
      throw err;
    }

    const failed =
      output.error || output.results.some((r) => r.status === 'failed');

    finalizeRun(runId, {
      status: failed ? 'failed' : 'completed',
      routeType: output.route.routeType,
      routeId: output.route.routeId,
      routeConfidence: output.route.confidence,
      routeReason: output.route.reason,
      finalResponse: output.finalResponse,
      error: output.error,
    });

    console.log(`\n━━━ Route ━━━`);
    console.log(`Agent: ${output.route.routeId ?? 'none'}`);
    console.log(`Reason: ${output.route.reason}`);
    console.log(`Confidence: ${output.route.confidence}`);

    if (output.warnings.length > 0) {
      console.log(`\n⚠ Warnings:`);
      for (const w of output.warnings) {
        console.log(`  - ${w}`);
      }
    }

    for (const [i, r] of output.results.entries()) {
      console.log(`\n━━━ Step ${i + 1}: ${r.status} ━━━`);
      console.log(r.summary);

      if (r.evidence.length > 0) {
        console.log(`\nEvidence:`);
        for (const e of r.evidence) {
          console.log(`  📄 ${e.path}`);
          if (e.excerpt) console.log(`     "${e.excerpt.slice(0, 100)}"`);
        }
      }

      if (r.changedFiles.length > 0) {
        console.log(`\nFiles:`);
        for (const f of r.changedFiles) {
          console.log(`  ${config.dryRun ? '🔍' : '✏️'} ${f.operation} ${f.path}`);
        }
      }
    }

    if (output.handoffs.length > 0) {
      console.log(`\n━━━ Handoffs ━━━`);
      for (const h of output.handoffs) {
        console.log(`  ${h.from} → ${h.to}: ${h.reason}`);
      }
    }

    console.log(`\n━━━ Response ━━━`);
    console.log(output.finalResponse);

    console.log(`\nRun ID: ${runId}`);

    if (failed) {
      console.error('\n❌ Run failed.');
      process.exitCode = 1;
    }
  });

program
  .command('routes')
  .description('Show routing for a request')
  .argument('<request...>', 'The request to route')
  .action(async (requestParts: string[]) => {
    const request = requestParts.join(' ');
    let agents;
    try {
      agents = ensureRegistry();
      ensureSkills();
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }

    const explicit = normalizeRequest(request, agents);
    if (explicit) {
      console.log('Route (explicit prefix):\n');
      console.log(JSON.stringify(explicit, null, 2));
      return;
    }

    console.log('Classifying via router...\n');
    const decision = await classifyRequest(request, agents);
    const final = enforcePolicy(decision, agents);

    console.log(JSON.stringify(final, null, 2));
  });

program
  .command('history')
  .description('List recent runs')
  .action(() => {
    const db = getDb();
    const runs = db
      .prepare(
        `SELECT id, started_at, status, selected_route_type,
                selected_route_id, substr(original_request, 1, 80) as preview
         FROM runs
         ORDER BY started_at DESC
         LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;

    if (runs.length === 0) {
      console.log('No runs yet.');
      return;
    }

    console.log('Recent runs:\n');
    for (const r of runs) {
      const status =
        r.status === 'completed'
          ? '✅'
          : r.status === 'failed'
            ? '❌'
            : '⏳';
      console.log(
        `  ${status} ${r.id?.toString().slice(0, 8)}  ${r.selected_route_id ?? '?'}  ${r.started_at?.toString().slice(0, 19)}  "${r.preview}"`,
      );
    }
  });

program
  .command('show-run')
  .description('Show details for a run')
  .argument('<run-id>', 'Run ID to inspect')
  .action((runId: string) => {
    const db = getDb();
    const run = db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(runId) as Record<string, unknown> | undefined;

    if (!run) {
      console.error(`Run not found: ${runId}`);
      process.exit(1);
    }

    console.log(JSON.stringify(run, null, 2));
  });

program
  .command('chat')
  .description('Interactive conversation with the crew (remembers context)')
  .action(async () => {
    let agents;
    try {
      agents = ensureRegistry();
      ensureSkills();
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }
    await runChat(agents);
  });

program
  .command('serve')
  .description(
    'Run an OpenAI-compatible HTTP server so GUI clients (Obsidian Copilot, Open WebUI) can chat with the crew',
  )
  .option('--demo', 'Use demo registry + demo vault (clean start, no personal data)')
  .action(async (options) => {
    let agents;
    try {
      // Demo mode: override registry path to the demo version
      if (options.demo) {
        resetRegistry();
        loadRegistry(resolve('crew', 'registry.demo.yaml'));
        agents = getAllAgents();
      } else {
        agents = ensureRegistry();
        ensureSkills();
      }
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }
    await runServe(agents, { demoMode: options.demo ?? false });
  });

program
  .command('worker')
  .description(
    'Run the background research worker — polls research_jobs, runs web research off the live chat turn, and writes findings to the vault',
  )
  .option('--once', 'Drain the queue once (process queued jobs, then exit) instead of polling forever')
  .action(async (options: { once?: boolean }) => {
    try {
      ensureRegistry(); // worker needs the Scribe agent for the write-back pass
      ensureSkills();
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }
    // Ensure the research_jobs table exists before polling.
    getDb();
    await runWorker({ once: options.once });
  });

program
  .command('sessions')
  .description('List recent chat sessions')
  .action(() => {
    const db = getDb();
    const sessions = db
      .prepare(
        `SELECT id, started_at, ended_at, turn_count
         FROM sessions
         ORDER BY started_at DESC
         LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;

    if (sessions.length === 0) {
      console.log('No chat sessions yet. Start one with: crew chat');
      return;
    }

    console.log('Recent sessions:\n');
    for (const s of sessions) {
      const open = s.ended_at ? ' ' : '⏳';
      console.log(
        `  ${open} ${s.id?.toString().slice(0, 8)}  ${s.turn_count} turn(s)  ${s.started_at?.toString().slice(0, 19)}`,
      );
    }
  });

program
  .command('show-session')
  .description('Show the turns of a chat session')
  .argument('<session-id>', 'Session ID (or its first 8 characters)')
  .action((sessionId: string) => {
    const db = getDb();
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = ? OR id LIKE ?`)
      .get(sessionId, `${sessionId}%`) as Record<string, unknown> | undefined;

    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    const runs = db
      .prepare(
        `SELECT started_at, selected_route_id, original_request, final_response
         FROM runs
         WHERE session_id = ?
         ORDER BY started_at ASC`,
      )
      .all(session.id) as Array<Record<string, unknown>>;

    console.log(
      `Session ${session.id?.toString().slice(0, 8)} — ${session.turn_count} turn(s), started ${session.started_at?.toString().slice(0, 19)}\n`,
    );
    for (const [i, r] of runs.entries()) {
      const req = r.original_request?.toString() ?? '';
      const msg = req.includes('## Current message')
        ? req.split('## Current message')[1]!.trim()
        : req;
      console.log(`━━━ Turn ${i + 1} → ${r.selected_route_id ?? '?'} ━━━`);
      console.log(`you: ${msg.slice(0, 300)}`);
      console.log(`${r.selected_route_id ?? 'crew'}: ${r.final_response?.toString().slice(0, 500)}\n`);
    }
  });

program
  .command('summarize-session')
  .description(
    'Summarize agent session observations (JSON via stdin) into a continuation checkpoint',
  )
  .option('--session-id <id>', 'Session ID for traceability')
  .option('--project <name>', 'Project the session was in')
  .option('--json', 'Output raw JSON instead of formatted text')
  .action(async (options: { sessionId?: string; project?: string; json?: boolean }) => {
    // Read observations from stdin
    let raw = '';
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    raw = Buffer.concat(chunks).toString('utf-8').trim();

    if (!raw) {
      console.error('No input provided. Pipe agentmemory observations as JSON array to stdin.');
      console.error('Example: echo \'[{...}]\' | crew summarize-session --session-id abc123');
      process.exit(1);
    }

    let observations: Observation[];
    try {
      const parsed = JSON.parse(raw);
      observations = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      console.error('stdin is not valid JSON. Expected an array of observations.');
      process.exit(1);
    }

    if (observations.length === 0) {
      console.error('No observations found in input.');
      process.exit(1);
    }

    const input: ContextSummarizationInput = {
      observations,
      sessionId: options.sessionId ?? 'unknown',
      project: options.project,
    };

    try {
      const config = getConfig();
      if (config.dryRun) {
        console.log('(DRY_RUN mode — LLM call will be simulated)\n');
        console.log(`Ready to summarize ${observations.length} observations.`);
        return;
      }

      const output = await summarizeObservations(input);

      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log('\n━━━ Summary ━━━');
        console.log(output.summary);
        console.log('');

        if (output.decisions.length > 0) {
          console.log('━━━ Decisions ━━━');
          for (const d of output.decisions) {
            const who = d.madeBy === 'Ben' ? '🧑 Ben' : '🤖 Agent';
            const rev = d.reversible ? ' (reversible)' : ' (irreversible)';
            console.log(`  ${who}${rev}: ${d.decision}`);
            console.log(`    ${d.rationale}`);
          }
          console.log('');
        }

        if (output.openItems.length > 0) {
          console.log('━━━ Open Items ━━━');
          for (const o of output.openItems) {
            const icon =
              o.status === 'blocked'
                ? '🚫'
                : o.status === 'waiting-on-ben'
                  ? '⏳'
                  : '🔄';
            console.log(`  ${icon} ${o.item}`);
            console.log(`    → ${o.nextAction}`);
          }
          console.log('');
        }

        console.log(`━━━ Checkpoint ━━━`);
        console.log(output.checkpoint);
        console.log('');

        if (output.filesTouched.length > 0) {
          console.log('━━━ Files ━━━');
          for (const f of output.filesTouched) {
            console.log(`  ${f.action} ${f.path}`);
          }
          console.log('');
        }

        console.log(
          `Session: ${output.sourceSessionId}  |  Completeness: ${Math.round(output.estimatedCompleteness * 100)}%`,
        );

        if (output.warnings?.length) {
          console.log('\n⚠ Warnings:');
          for (const w of output.warnings) {
            console.log(`  - ${w}`);
          }
        }
      }
    } catch (err) {
      console.error(`Summarization failed: ${String(err)}`);
      process.exit(1);
    }
  });

program
  .command('onboard')
  .description('Guided interactive vault setup and onboarding')
  .option('--reset', 'Restart onboarding from scratch')
  .action(async (options: { reset?: boolean }) => {
    try {
      ensureRegistry();
      ensureSkills();
    } catch (err) {
      console.error(`Registry error: ${String(err)}`);
      process.exit(1);
    }

    const config = getConfig();
    initializeRuntime();

    if (options.reset) {
      clearOnboardingState();
      console.log('Onboarding reset. Starting fresh.\n');
    }

    // Vault is optional — guard against empty path.
    if (!config.obsidianVaultPath) {
      console.log('No vault configured. Set OBSIDIAN_VAULT_PATH in .env to use onboarding.');
      return;
    }

    // Vault-initialized guard: refuse to run if vault already exists
    if (!options.reset && isVaultInitialized(config.obsidianVaultPath)) {
      console.log('Your vault is already set up!');
      console.log('\nTo re-run onboarding: crew onboard --reset');
      return;
    }

    let state = loadOnboardingState();

    if (state && state.phase === 'complete') {
      console.log('Onboarding is already complete!');
      console.log(`Started: ${state.startedAt}`);
      console.log('\nTo re-run onboarding: crew onboard --reset');
      return;
    }

    if (state) {
      console.log(`Resuming onboarding from "${state.phase}"...`);
      console.log(`Already answered: ${state.askedQuestions.join(', ')}\n`);
    } else {
      state = createFreshState();
      saveOnboardingState(state);
      console.log('Welcome to Ax Brain Crew onboarding!\n');
      console.log('I\'ll ask you a few questions to set up your vault.');
      console.log('You can press Ctrl+C at any time to pause. Your progress is saved.\n');
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (true) {
        const question = await askNextQuestion(state);

        if (question.done) {
          console.log(`\n${question.question}`);
          let answer = '';
          try {
            answer = await rl.question('\nYou › ');
          } catch {
            console.log('\nInput closed. Saving state and exiting.');
            break;
          }
          state = applyAnswer(state, question.field, answer, question.nextPhase);
          saveOnboardingState(state);

          console.log('\nCreating vault structure...\n');
          const created = createVaultFromAnswers(state.answers);

          console.log('Created files:');
          for (const f of created) {
            console.log(`  ✏️ ${f}`);
          }

          state.phase = 'complete';
          saveOnboardingState(state);
          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log('✅ Onboarding complete! Your vault is ready.');
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log('\nNext steps:');
          console.log('  npm run crew -- ask "Save this thought: [your thought]"');
          console.log('  npm run crew -- ask "/sorter triage my inbox"');
          console.log(`\nState saved. To re-run: crew onboard --reset`);
          break;
        }

        console.log(`\n${question.question}`);
        if (question.hint) {
          console.log(`  (e.g., ${question.hint})`);
        }

        let answer = '';
        try {
          answer = await rl.question('\nYou › ');
        } catch {
          console.log('\nInput closed. Progress saved. Run "crew onboard" to resume.');
          break;
        }
        state = applyAnswer(state, question.field, answer, question.nextPhase);
        saveOnboardingState(state);
      }
    } finally {
      rl.close();
    }
  });

program.parse();
