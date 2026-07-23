---
date: 2026-07-24
type: reference
tags:
  - ax
  - demo
  - agent-development
ai-first: true
---

# Adding Your Own Agent

Agents in Ax Brain Crew are defined in two files:

1. **`crew/registry.yaml`** — metadata: name, model tier, allowed tools, trigger phrases
2. **`crew/agents/<your-agent>.md`** — the instruction prompt the agent follows

## Step-by-step

### 1. Create the instruction file

Create `crew/agents/my-agent.md`:

```markdown
# My Agent — does something useful

## Identity
You are My Agent, a specialist that [describe what it does].

## Rules
- Rule 1
- Rule 2

## Output Format
Return your response as structured output.
```

### 2. Register in registry.yaml

Add an entry under `agents:`:

```yaml
my-agent:
  name: My Agent
  description: Does something useful
  instructions: crew/agents/my-agent.md
  modelTier: fast          # fast, smart, or router
  allowedTools: []          # tool names from the tool registry
  triggers:
    - do the thing
    - my agent
  handoffs:
    allowedTargets:
      - demo-assistant
```

### 3. Restart and use

```bash
npm run crew -- serve
```

Your agent appears in the visual lab's Components tab and responds to its trigger phrases in chat.

## Architecture

The YAML is just configuration. The actual agent execution is handled by AxLLM's `agent()` function in `src/runtime/executor.ts`. The YAML tells the runtime what tools to give the agent and when to route to it; Ax handles the reasoning, tool calling, and structured output.

For custom tools: add the tool to `src/agents/factory.ts`, then reference it by name in your agent's `allowedTools` list.
