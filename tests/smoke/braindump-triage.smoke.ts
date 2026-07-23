// Smoke test for braindump-triage flow.
// Run: npx tsx tests/smoke/braindump-triage.smoke.ts

async function main() {
  // Init runtime (set vault root) — same as crew daemon start.
  const { initializeRuntime } = await import('../../src/runtime/init.js');
  initializeRuntime();

  const { runBraindumpTriageFlow } = await import(
    '../../src/flows/braindump-triage.js'
  );

  const sampleBraindump = [
    'triage this braindump:',
    '',
    '1. a react infinite scroll component that works with virtualized lists',
    '2. investigate whether we should switch from vitest to node:test',
    '3. the 401 error in the github-mcp-proxy is still happening sometimes',
    '4. remind me to refactor the dispatcher.ts file — it is getting too long',
    '5. something about behavioral economics and loss aversion for the knowledge base',
  ].join('\n');

  console.log('=== BRAINDUMP-TRIAGE SMOKE TEST (dry-run) ===');
  console.log('Input:', sampleBraindump.slice(0, 150), '...\n');

  const result = await runBraindumpTriageFlow({
    request: sampleBraindump,
    dryRun: true,
    runId: 'smoke-braindump-1',
  });

  console.log('=== OUTPUT ===');
  console.log('Item count:', result.output.itemCount);
  console.log('Item notes:', result.output.itemNotes);
  console.log('Base path:', result.output.basePath);
  console.log('Raw source path:', result.output.rawSourcePath);
  console.log('Warnings:', result.output.warnings.length);
  for (const w of result.output.warnings) {
    console.log('  ⚠️', w);
  }
  console.log('\n=== RESPONSE ===');
  console.log(result.finalResponse);
  console.log('\n=== PASS ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
