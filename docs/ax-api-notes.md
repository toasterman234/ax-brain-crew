# Ax API Notes

> Verified against `@ax-llm/ax` v21.0.14 installed at `~/ax-llm/node_modules/@ax-llm/ax/`

## Import Map

```typescript
import { ai, ax, agent, fn, f, flow, s } from '@ax-llm/ax';
```

Also available: `AxGen`, `AxProgram`, `AxAgent`, `AxFlow`, `AxSignature`, `AxSignatureBuilder`.

## Key Patterns

### 1. Create LLM client (`ai`)

```typescript
const llm = ai({
  name: 'openai',
  apiKey: process.env.PROXY_API_KEY,
  apiURL: 'http://127.0.0.1:8787/v1', // OpenAI-compatible CommandCode endpoint
  config: { model: 'deepseek/deepseek-v4-pro' as any },
});
```

**NPM package name**: `@ax-llm/ax`  
**Import name in code**: `@ax-llm/ax`

### 2. Simple program (`ax`)

```typescript
const classifier = ax('request:string -> routeType, routeId, confidence:number, reason');
const result = await classifier.forward(llm, { request: '...' });
```

### 3. Agent with tools (`agent` + `fn`)

```typescript
const myTool = fn('toolName')
  .description('Does something')
  .arg('param', f.string('description'))
  .returns(f.string('output'))
  .handler(async ({ param }) => 'result')
  .build();

const myAgent = agent('input:string -> output:string', {
  agentIdentity: { name: 'My Agent', description: '...' },
  functions: [myTool],
});
```

### 4. Structured output with validation (`f`)

```typescript
const sig = f()
  .input('request', f.string())
  .output('decision', f.object({
    choice: f.class(['a', 'b', 'c']),
    confidence: f.number().min(0).max(1),
    reason: f.string(),
  }));
```

### 5. Multi-agent with child agents as tools

```typescript
const parent = agent('question -> answer', {
  agentIdentity: { name: 'Parent', description: '...' },
  functions: [childAgent1, childAgent2],
});
```

## Provider Support

`ai()` supports: `'openai'`, `'anthropic'`, `'google-gemini'`, `'azure-openai'`, `'cohere'`, `'mistral'`, `'deepseek'`, `'reka'`, `'grok'`.

For CommandCode/custom OpenAI-compatible endpoints, use `name: 'openai'` with `apiURL`.

## Project Integration

For this project, the key patterns are:

1. **Router** → `ax()` with classification signature
2. **Specialists** → `agent()` with `agentIdentity` + vault tools as `fn()` built functions
3. **Model clients** → `ai()` with `apiURL` pointing to CommandCode
4. **Tool creation** → `fn().description().arg().handler().build()`

## Tested APIs

| API | Verified | Notes |
|-----|----------|-------|
| `ai({ name: 'openai', apiURL })` | ✅ | CommandCode proxy; from Ben's production code + upstream examples |
| `ax('signature')` | ✅ | From README + upstream examples |
| `agent('signature', { agentIdentity, functions })` | ✅ | From upstream/examples/agent.ts |
| `fn('name').description().arg().handler().build()` | ✅ | From Ben's ax-llm/agent/index.ts |
| `f().input().output()` | ✅ | From upstream/examples/structured_output.ts |
