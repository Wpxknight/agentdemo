import type { AgentRunEvent, JsonValue } from '@aiop/control-contracts';
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';

export interface EventCodecOptions {
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  correlationId: string;
  sequence: () => bigint;
  now?: () => Date;
}

const MAX_STRING = 512;
const MAX_NAME = 128;
const MAX_ARRAY = 32;
const MAX_KEYS = 32;
const MAX_DEPTH = 5;
const MAX_DETAIL_BYTES = 8192;
const SENSITIVE_KEY = /authorization|cookie|api[-_]?key|token|secret|password|credential/i;

export class EventCodec {
  private readonly now: () => Date;

  constructor(private readonly options: EventCodecOptions) {
    this.now = options.now ?? (() => new Date());
  }

  fromPi(event: AgentHarnessEvent): AgentRunEvent {
    const known = KNOWN_EVENTS.has(event.type);
    const detail = toDurableJsonValue(known ? projectKnown(event) : {
      version: 1, kind: 'pi_harness_event', originalType: limited(event.type, MAX_NAME), keys: safeKeys(event),
    });
    return {
      tenantId: this.options.tenantId, runId: this.options.runId, attemptId: this.options.attemptId,
      turnNo: this.options.turnNo, kernel: 'pi', kernelVersion: '0.82.1',
      correlationId: this.options.correlationId, sequence: this.options.sequence(),
      type: known ? event.type : 'pi_extension', detail, createdAt: this.now(),
    };
  }
}

function projectKnown(event: AgentHarnessEvent): Record<string, unknown> {
  switch (event.type) {
    case 'agent_start': case 'turn_start': return { version: 1 };
    case 'agent_end': return { version: 1, messageCount: event.messages.length };
    case 'turn_end': return { version: 1, message: safeMessage(event.message), toolResultCount: event.toolResults.length };
    case 'message_start': case 'message_end': return { version: 1, message: safeMessage(event.message) };
    case 'message_update': return {
      version: 1, message: safeMessage(event.message), update: safeAssistantUpdate(event.assistantMessageEvent),
    };
    case 'tool_execution_start': return {
      version: 1, toolCallId: limited(event.toolCallId, MAX_NAME), toolName: limited(event.toolName, MAX_NAME),
      inputKeys: objectKeys(event.args),
    };
    case 'tool_execution_update': return {
      version: 1, toolCallId: limited(event.toolCallId, MAX_NAME), toolName: limited(event.toolName, MAX_NAME),
      inputKeys: objectKeys(event.args), partial: valueShape(event.partialResult),
    };
    case 'tool_execution_end': return {
      version: 1, toolCallId: limited(event.toolCallId, MAX_NAME), toolName: limited(event.toolName, MAX_NAME),
      isError: event.isError, result: valueShape(event.result),
    };
    case 'tool_call': return {
      version: 1, toolCallId: limited(event.toolCallId, MAX_NAME), toolName: limited(event.toolName, MAX_NAME),
      inputKeys: objectKeys(event.input),
    };
    case 'tool_result': return {
      version: 1, toolCallId: limited(event.toolCallId, MAX_NAME), toolName: limited(event.toolName, MAX_NAME),
      inputKeys: objectKeys(event.input), isError: event.isError, usage: safeUsage(event.usage),
      content: event.content.slice(0, MAX_ARRAY).map(contentShape), details: valueShape(event.details),
    };
    case 'queue_update': return {
      version: 1, steerCount: event.steer.length, followUpCount: event.followUp.length, nextTurnCount: event.nextTurn.length,
    };
    case 'save_point': return { version: 1, hadPendingMutations: event.hadPendingMutations };
    case 'abort': return { version: 1, clearedSteerCount: event.clearedSteer.length, clearedFollowUpCount: event.clearedFollowUp.length };
    case 'settled': return { version: 1, nextTurnCount: event.nextTurnCount };
    case 'before_agent_start': return {
      version: 1, promptLength: event.prompt.length, systemPromptLength: event.systemPrompt.length,
      imageCount: event.images?.length ?? 0, skillCount: event.resources.skills?.length ?? 0,
      promptTemplateCount: event.resources.promptTemplates?.length ?? 0,
      skillNames: names(event.resources.skills), templateNames: names(event.resources.promptTemplates),
    };
    case 'context': return { version: 1, messageCount: event.messages.length, roles: event.messages.slice(0, MAX_ARRAY).map((m) => m.role) };
    case 'before_provider_request': return {
      version: 1, model: safeModel(event.model), sessionId: limited(event.sessionId, MAX_NAME),
      streamOptionKeys: objectKeys(event.streamOptions), streamOptionCount: Object.keys(event.streamOptions).length,
    };
    case 'before_provider_payload': return {
      version: 1, model: safeModel(event.model), payloadType: valueType(event.payload),
      payloadKeys: objectKeys(event.payload), estimatedBytes: estimateBytes(event.payload),
    };
    case 'after_provider_response': return { version: 1, status: event.status, headerNames: Object.keys(event.headers).sort().slice(0, MAX_ARRAY).map((n) => limited(n, MAX_NAME)) };
    case 'session_before_compact': return {
      version: 1, branchEntryCount: event.branchEntries.length, tokensBefore: event.preparation.tokensBefore,
      messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
      retainedTailCount: event.preparation.retainedTail.length, signal: safeSignal(event.signal),
      customInstructionsLength: event.customInstructions?.length ?? 0,
    };
    case 'session_compact': return {
      version: 1, entryId: limited(event.compactionEntry.id, MAX_NAME), fromHook: event.fromHook,
      tokensBefore: event.compactionEntry.tokensBefore, summaryLength: event.compactionEntry.summary.length,
    };
    case 'session_before_tree': return {
      version: 1, targetId: limited(event.preparation.targetId, MAX_NAME),
      entryCount: event.preparation.entriesToSummarize.length, summarize: event.preparation.userWantsSummary,
      signal: safeSignal(event.signal),
    };
    case 'session_tree': return {
      version: 1, newLeafId: safeName(event.newLeafId), oldLeafId: safeName(event.oldLeafId),
      summaryEntryId: safeName(event.summaryEntry?.id), fromHook: event.fromHook ?? false,
    };
    case 'retry_scheduled': return {
      version: 1, operation: event.operation, attempt: event.attempt, maxAttempts: event.maxAttempts,
      delayMs: event.delayMs, errorMessage: limited(event.errorMessage, MAX_STRING),
    };
    case 'retry_attempt_start': case 'retry_finished': return { version: 1, operation: event.operation };
    case 'model_update': return { version: 1, model: safeModel(event.model), previousModel: safeModel(event.previousModel), source: event.source };
    case 'thinking_level_update': return { version: 1, level: event.level, previousLevel: event.previousLevel };
    case 'resources_update': return {
      version: 1, skillCount: event.resources.skills?.length ?? 0, templateCount: event.resources.promptTemplates?.length ?? 0,
      skillNames: names(event.resources.skills), templateNames: names(event.resources.promptTemplates),
    };
    case 'tools_update': return {
      version: 1, toolNames: event.toolNames.slice(0, MAX_ARRAY).map((n) => limited(n, MAX_NAME)),
      activeToolNames: event.activeToolNames.slice(0, MAX_ARRAY).map((n) => limited(n, MAX_NAME)), source: event.source,
    };
  }
}

function safeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') return { type: valueType(message) };
  const m = message as Record<string, unknown>;
  const content = Array.isArray(m.content) ? m.content.slice(0, MAX_ARRAY).map(contentShape)
    : typeof m.content === 'string' ? [{ type: 'text', text: limited(m.content, MAX_STRING), length: m.content.length }] : [];
  return {
    role: safeName(typeof m.role === 'string' ? m.role : undefined), content,
    stopReason: safeName(typeof m.stopReason === 'string' ? m.stopReason : undefined), usage: safeUsage(m.usage),
    toolCallId: safeName(typeof m.toolCallId === 'string' ? m.toolCallId : undefined),
    toolName: safeName(typeof m.toolName === 'string' ? m.toolName : undefined), isError: m.isError === true,
  };
}

function contentShape(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object') return { type: valueType(content) };
  const c = content as Record<string, unknown>;
  const type = typeof c.type === 'string' ? limited(c.type, MAX_NAME) : 'unknown';
  if (type === 'text' || type === 'thinking') {
    const text = typeof c.text === 'string' ? c.text : typeof c.content === 'string' ? c.content : '';
    return { type, text: limited(text, MAX_STRING), length: text.length };
  }
  if (type === 'image') return { type, mimeType: safeName(typeof c.mimeType === 'string' ? c.mimeType : undefined), dataLength: typeof c.data === 'string' ? c.data.length : 0 };
  if (type === 'toolCall') return { type, id: safeName(typeof c.id === 'string' ? c.id : undefined), name: safeName(typeof c.name === 'string' ? c.name : undefined), argumentKeys: objectKeys(c.arguments) };
  return { type, keys: objectKeys(c) };
}

function safeAssistantUpdate(update: unknown): Record<string, unknown> {
  if (!update || typeof update !== 'object') return { type: valueType(update) };
  const u = update as Record<string, unknown>;
  return {
    type: safeName(typeof u.type === 'string' ? u.type : undefined),
    contentIndex: typeof u.contentIndex === 'number' ? u.contentIndex : undefined,
    delta: typeof u.delta === 'string' ? limited(u.delta, MAX_STRING) : undefined,
    content: typeof u.content === 'string' ? limited(u.content, MAX_STRING) : undefined,
  };
}

function safeModel(model: unknown): Record<string, unknown> | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const m = model as Record<string, unknown>;
  return { id: safeName(stringValue(m.id)), provider: safeName(stringValue(m.provider)), api: safeName(stringValue(m.api)) };
}

function safeUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  return { input: numberValue(u.input), output: numberValue(u.output), cacheRead: numberValue(u.cacheRead), cacheWrite: numberValue(u.cacheWrite), totalTokens: numberValue(u.totalTokens) };
}

function safeSignal(signal: AbortSignal): Record<string, unknown> {
  return { aborted: signal.aborted, ...(signal.aborted ? { reason: toDurableJsonValue(signal.reason) } : {}) };
}

function names(values: readonly { name: string }[] | undefined): string[] {
  return (values ?? []).slice(0, MAX_ARRAY).map((value) => limited(value.name, MAX_NAME));
}

function valueShape(value: unknown): Record<string, unknown> {
  return { type: valueType(value), keys: objectKeys(value), estimatedBytes: estimateBytes(value) };
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((key) => !SENSITIVE_KEY.test(key)).sort().slice(0, MAX_KEYS).map((key) => limited(key, MAX_NAME)) : [];
}

function safeKeys(event: unknown): string[] {
  return objectKeys(event).filter((key) => key !== 'type');
}

export function toDurableJsonValue(value: unknown): JsonValue {
  const sanitized = sanitize(value, 0, new WeakSet<object>());
  const json = JSON.stringify(sanitized);
  return Buffer.byteLength(json) <= MAX_DETAIL_BYTES ? sanitized : {
    version: 1, kind: 'truncated_detail', truncated: true, originalBytes: Buffer.byteLength(json),
  };
}

function sanitize(value: unknown, depth: number, path: WeakSet<object>): JsonValue {
  if (depth > MAX_DEPTH) return { kind: 'truncated_depth' };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return limited(value, MAX_STRING);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value instanceof Date) return value.toISOString();
  if (path.has(value as object)) return { kind: 'circular_reference' };
  path.add(value as object);
  try {
    if (value instanceof Error) return sanitize({ name: value.name, message: value.message, code: (value as Error & { code?: unknown }).code, cause: value.cause }, depth + 1, path);
    if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return sanitize({ aborted: value.aborted, ...(value.aborted ? { reason: value.reason } : {}) }, depth + 1, path);
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, path));
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort().slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(key)) { output[key] = '[REDACTED]'; continue; }
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') continue;
      output[key] = sanitize(item, depth + 1, path);
    }
    return output;
  } finally {
    path.delete(value as object);
  }
}

function estimateBytes(value: unknown, depth = 0): number {
  if (depth > 3 || value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).length;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).reduce((sum, item) => sum + estimateBytes(item, depth + 1), 0);
  if (typeof value === 'object') return Object.keys(value).slice(0, MAX_KEYS).reduce((sum, key) => sum + key.length + estimateBytes((value as Record<string, unknown>)[key], depth + 1), 0);
  return 0;
}

function limited(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}…[truncated:${value.length}]`; }
function safeName(value: string | null | undefined): string | null | undefined { return value == null ? value : limited(value, MAX_NAME); }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function valueType(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }

export const PI_HARNESS_EVENT_TYPES = [
  'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'tool_call', 'tool_result',
  'queue_update', 'save_point', 'abort', 'settled', 'before_agent_start', 'context',
  'before_provider_request', 'before_provider_payload', 'after_provider_response', 'session_before_compact',
  'session_compact', 'session_before_tree', 'session_tree', 'retry_scheduled', 'retry_attempt_start',
  'retry_finished', 'model_update', 'thinking_level_update', 'resources_update', 'tools_update',
] as const satisfies readonly AgentHarnessEvent['type'][];

const KNOWN_EVENTS = new Set<string>(PI_HARNESS_EVENT_TYPES);
type MissingPiHarnessEvent = Exclude<AgentHarnessEvent['type'], typeof PI_HARNESS_EVENT_TYPES[number]>;
const ALL_PI_HARNESS_EVENTS_PROJECTED: MissingPiHarnessEvent extends never ? true : never = true;
void ALL_PI_HARNESS_EVENTS_PROJECTED;
