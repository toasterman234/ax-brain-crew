import { z } from 'zod';

export const agentDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  modelTier: z.enum(['router', 'fast', 'smart']),
  // Optional exact model id; overrides the tier's model for this agent.
  model: z.string().optional(),
  allowedTools: z.array(z.string()).min(1),
  triggers: z.array(z.string()).min(1),
  handoffs: z
    .object({
      allowedTargets: z.array(z.string()).optional(),
    })
    .optional(),
});

export const registrySchema = z.object({
  agents: z.record(z.string().min(1), agentDefSchema),
});

export type AgentDef = z.infer<typeof agentDefSchema>;
export type Registry = z.infer<typeof registrySchema>;
