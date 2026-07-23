// Smoke test for prior-art flow.
// Run: npx tsx tests/smoke/prior-art.smoke.ts

async function main() {
  // Dynamic import so tsx properly resolves .ts extensions
  const { runPriorArtFlow } = await import('../../src/flows/prior-art.js');

  const result = await runPriorArtFlow({
    idea: 'react infinite scroll component',
    topN: 3,
    runId: 'smoke-test-1',
  });

  console.log('=== SMOKE TEST RESULTS ===');
  console.log('Matches found:', result.output.discovery.totalMatches);
  console.log('Deep-dives:', result.output.deepDives.length);
  console.log('Synthesis:', result.output.synthesis ? 'present' : 'absent');
  console.log('Warnings:', result.output.warnings.length);

  if (result.output.deepDives.length > 0) {
    const top = result.output.deepDives[0]!;
    console.log('\nTop match:', JSON.stringify({
      name: top.name,
      recommendation: top.recommendation,
      stars: top.stars,
      githubRepo: top.githubRepo,
    }, null, 2));
  }

  console.log('Synthesis:', JSON.stringify(result.output.synthesis, null, 2));
  console.log('\n=== RESPONSE ===');
  console.log(result.finalResponse);
  console.log('\n=== PASS ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
