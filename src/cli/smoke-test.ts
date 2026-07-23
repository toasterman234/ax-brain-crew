import { ax } from '@ax-llm/ax';
import { createRouterClient } from '../ai/clients.js';
import { getLogger } from '../observability/logger.js';

export async function runSmokeTest(): Promise<{
  pass: boolean;
  detail: string;
  output?: unknown;
}> {
  const logger = getLogger();
  logger.info('Creating model client via CommandCode proxy...');

  let llm;
  try {
    llm = createRouterClient();
  } catch (err) {
    return { pass: false, detail: `Failed to create client: ${String(err)}` };
  }

  logger.info('Running structured classification call...');

  try {
    const classifier = ax(
      'reviewText:string -> sentiment:class "positive, negative, neutral", confidence:number',
    );

    const result = await classifier.forward(llm, {
      reviewText: 'Ax Brain Crew is a fascinating project that helps organize thoughts.',
    });

    logger.info(
      { result },
      `Smoke test result: sentiment=${String(result.sentiment)} confidence=${String(result.confidence)}`,
    );

    return {
      pass: true,
      detail: `Classification complete`,
      output: result,
    };
  } catch (err) {
    return {
      pass: false,
      detail: `Ax call failed: ${String(err)}`,
    };
  }
}
