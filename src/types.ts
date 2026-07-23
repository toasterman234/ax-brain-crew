export interface AgentResult {
  status: "completed" | "needs_input" | "blocked" | "failed";
  response: string;
  summary: string;
  changedFiles: ChangedFile[];
  evidence: EvidenceItem[];
  suggestedNextAgent: string | null;
  nextAgentReason: string | null;
  nextAgentContext: string | null;
  warnings: string[];
}

export interface ChangedFile {
  path: string;
  operation: "created" | "updated" | "moved" | "deleted";
  previousPath?: string;
  description: string;
}

export interface EvidenceItem {
  path: string;
  excerpt?: string;
  relevance: string;
}

export interface RouteDecision {
  routeType: "skill" | "agent" | "clarify" | "none";
  routeId: string | null;
  confidence: number;
  reason: string;
  alternatives: Array<{
    routeId: string;
    confidence: number;
  }>;
  clarificationQuestion: string | null;
}

export interface HandoffPacket {
  originalRequest: string;
  previousAgent: string;
  previousSummary: string;
  reason: string;
  relevantFiles: string[];
  changedFiles: ChangedFile[];
  constraints: string[];
}

export type ApprovalLevel = 0 | 1 | 2;

export type ModelTier = "router" | "fast" | "smart";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelTier: ModelTier;
  allowedTools: string[];
  triggers: string[];
  handoffs?: {
    allowedTargets: string[];
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  approvalLevel: ApprovalLevel;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  originalRequest: string;
  selectedRouteType: string | null;
  selectedRouteId: string | null;
  routeConfidence: number | null;
  routeReason: string | null;
  finalResponse: string | null;
  error: string | null;
}

export interface StepRecord {
  id: string;
  runId: string;
  stepNumber: number;
  agentOrSkillId: string;
  model: string | null;
  modelTier: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  suggestedNextAgent: string | null;
  nextAgentReason: string | null;
  warnings: string | null;
}

export interface ToolCallRecord {
  id: string;
  stepId: string;
  toolName: string;
  input: string;
  output: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export interface ChangedFileRecord {
  id: string;
  runId: string;
  stepId: string | null;
  path: string;
  operation: string;
  previousPath: string | null;
  description: string | null;
}
