import { ax } from '@ax-llm/ax';
import { createRouterClient } from '../ai/clients.js';
import type { RouteDecision } from '../types.js';
import type { ValidatedAgent } from '../registry/loader.js';
import { getLogger } from '../observability/logger.js';

function buildClassificationPrompt(agents: ValidatedAgent[]): string {
  const agentList = agents
    .map(
      (a) =>
        `- ${a.id}: ${a.description} (triggers: ${a.triggers.slice(0, 5).join(', ')})`,
    )
    .join('\n');

  return [
    'Classify the user request to the best specialist agent.',
    '',
    'Available agents:',
    agentList,
    '',
    'Rules:',
    '- routeType must be "agent" if you can match, or "clarify" if ambiguous, or "none" if no match',
    '- routeId must exactly match an agent id above',
    '- confidence 0-1: 0.9+ for clear matches, lower for guesses',
    '',
    'Routing heuristics:',
    '- Capturing/creating/writing notes → scribe',
    '- Searching/finding/researching/asking → seeker',
    '- Requests to find, collect, or synthesize external information (forums, sources, web research, articles, "has anyone built X", legal/market/news research) → seeker, NOT conductor. Even if the request starts with "can you" or "find my", if it asks for external sources or web research, route to seeker.',
    '- Organizing/filing/sorting/tidying → sorter',
    '- Scaffolding/structuring/setting up areas or MOCs → architect',
    '- Linking/connecting notes/finding relationships/orphans/themes → connector',
    '- Auditing/validating/checking vault health/broken links/frontmatter issues → librarian',
    '- Filesystem/GitHub exploration: when the user gives a SPECIFIC path or explicit instruction ("walk /Users/username/projects", "list github repos for username") → scout. When vague ("explore my projects", "find my stuff on disk", "what projects do I have", "discover my repos") → conductor',
    '',
    'Default to conductor:',
    '- If the request is vague ("explore", "find my stuff", "help me set up", "what do I have", "I need to"), route to conductor, NOT a specialist',
    '- If the request spans multiple domains (filesystem + vault + github), route to conductor',
    '- Scout exploration triggers ("explore my projects", "find my projects", "scan my filesystem", "what projects do I have", "discover my repos", "inventory my projects") ALWAYS route to conductor first — Conductor scopes, then dispatches scout',
    '- If you are unsure which specialist to pick, route to conductor with moderate confidence (0.6–0.7) instead of clarifying',
    '- Only use "clarify" when NO agent (including conductor) can help — not when you are unsure about specialist routing',
  ].join('\n');
}

export async function classifyRequest(
  input: string,
  agents: ValidatedAgent[],
): Promise<RouteDecision> {
  const logger = getLogger();

  if (agents.length === 0) {
    return {
      routeType: 'none',
      routeId: null,
      confidence: 0,
      reason: 'No agents registered',
      alternatives: [],
      clarificationQuestion: null,
    };
  }

  const agentIds = agents.map((a) => a.id);
  const systemPrompt = buildClassificationPrompt(agents);

  const llm = createRouterClient();

  const classifier = ax(
    `userRequest:string -> routeType:class "agent, clarify, none", routeId:string, confidence:number, reason:string, clarificationQuestion?:string`,
  );

  const fullRequest = `${systemPrompt}\n\nUser request: ${input}`;

  try {
    const result = await classifier.forward(llm, { userRequest: fullRequest });

    logger.info({ result }, 'Router classification result');

    const routeId = result.routeId?.trim() ?? null;
    const confidence = Number(result.confidence) || 0;

    if (result.routeType === 'agent' && routeId && agentIds.includes(routeId)) {
      return {
        routeType: 'agent',
        routeId,
        confidence: Math.min(Math.max(confidence, 0), 1),
        reason: result.reason?.trim() ?? 'Classified by router',
        alternatives: [],
        clarificationQuestion: result.clarificationQuestion?.trim() ?? null,
      };
    }

    if (result.routeType === 'clarify') {
      return {
        routeType: 'clarify',
        routeId: null,
        confidence,
        reason: result.reason?.trim() ?? 'Router needs clarification',
        alternatives: [],
        clarificationQuestion:
          result.clarificationQuestion?.trim() ??
          'Could you clarify what you want me to do?',
      };
    }

    return {
      routeType: 'none',
      routeId: null,
      confidence: 0,
      reason: result.reason?.trim() ?? 'Could not classify request',
      alternatives: [],
      clarificationQuestion: null,
    };
  } catch (err) {
    logger.error({ err }, 'Router classification failed');
    return {
      routeType: 'none',
      routeId: null,
      confidence: 0,
      reason: `Classification error: ${String(err)}`,
      alternatives: [],
      clarificationQuestion: null,
    };
  }
}
