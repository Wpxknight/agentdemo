import type { IdentityContext } from './identity.js';
import type { JsonValue } from './json.js';

export type WaitingReason = 'approval' | 'question' | 'plan' | 'external';
export type InteractionKind = Exclude<WaitingReason, 'external'>;
export type InteractionStatus = 'pending' | 'resolved' | 'cancelled' | 'expired';

export interface InteractionResolution {
  interactionId: string;
  value: JsonValue;
}

export interface ResolveInteractionInput extends InteractionResolution {
  identity: IdentityContext;
  runId: string;
}

export interface ResolvedInteraction {
  interactionId: string;
  kind: InteractionKind;
  toolCallId: string;
  value: JsonValue;
}

export interface DurableInteractionUpdate {
  tenantId: string;
  runId: string;
  id: string;
  userId?: string;
  sessionId?: string;
  attemptId: string;
  turnNo: number;
  kind: InteractionKind;
  toolCallId?: string;
  status: InteractionStatus;
  payload: JsonValue;
  resolution?: JsonValue;
  resolvedBy?: string;
  expiresAt?: Date;
  createdAt: Date;
  resolvedAt?: Date;
}
