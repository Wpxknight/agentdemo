import type { ChatModel, JsonValue, Msg, StreamEvent, ToolContentBlock, ToolDef } from '../model/types.js';
import type { PolicyMiddleware } from './policy.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import type { ApprovalGate } from './approval.js';
import type { HookRunner } from './hooks.js';
import type { QuestionAnswers, QuestionSpec } from './question.js';
import type { ChangePlan } from './plan.js';
import type { DurableToolLedger } from './tool-ledger/store.js';
import type { AgentRunLifecycleObserver } from './run-coordinator.js';

export type { Usage } from './services/model-gateway.js';
import type { Usage } from './services/model-gateway.js';

export interface RunAgentOptions {
  runId?: string;
  rolloutMode?: 'read-only' | 'dry-run' | 'replay' | 'full';
  comparisonRunId?: string;
  model: ChatModel;
  tools: ToolRegistry;
  policy: PolicyMiddleware;
  system?: string;
  task?: string;
  taskContentBlocks?: ToolContentBlock[];
  messages?: Msg[];
  ctx: ToolContext;
  onEvent?: (e: StreamEvent) => void;
  drainPendingMessages?: () => Msg[] | Promise<Msg[]>;
  maxSteps?: number;
  contextBudgetTokens?: number;
  keepImages?: number;
  summarize?: (stale: Msg[]) => Promise<string>;
  compactionTriggerTokens?: number;
  compactionKeepRecent?: number;
  compactionWatermarkTokens?: number;
  modelRetryDelayMs?: number;
  approval?: ApprovalGate;
  filterToolDefs?: (defs: ToolDef[]) => ToolDef[];
  hooks?: HookRunner;
  toolLedger?: DurableToolLedger;
  durableInteractions?: {
    create(input: {
      kind: 'approval' | 'question' | 'plan';
      toolCallId: string;
      payload: unknown;
    }): Promise<{ id: string }>;
    wait(id: string): Promise<unknown>;
  };
  askUser?: (questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  requestPlanApproval?: (plan: ChangePlan) => Promise<boolean>;
  unattended?: boolean;
  signal?: AbortSignal;
  runLifecycle?: AgentRunLifecycleObserver;
  runGuard?: () => Promise<void>;
  resumeFromCheckpoint?: boolean;
  interactionResolution?: { interactionId: string; value: JsonValue };
}

export interface RunAgentResult {
  messages: Msg[];
  text: string;
  steps: number;
  usage: Usage;
  compacted: boolean;
  rollout?: {
    mode: 'dry-run' | 'replay';
    sourceRunId?: string;
    sourceUsage?: Usage;
    usageDelta?: Usage;
  };
}
