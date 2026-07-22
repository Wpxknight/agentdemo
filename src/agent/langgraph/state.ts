import { Annotation } from '@langchain/langgraph';
import type { Msg, ToolCall } from '../../model/types.js';
import type { Usage } from '../services/model-gateway.js';

export const AgentGraphState = Annotation.Root({
  messages: Annotation<Msg[]>(),
  text: Annotation<string>(),
  steps: Annotation<number>(),
  usage: Annotation<Usage>(),
  compacted: Annotation<boolean>(),
  compactionWatermark: Annotation<number>(),
  calls: Annotation<ToolCall[]>(),
  continueModel: Annotation<boolean>(),
});

export type AgentGraphStateValue = typeof AgentGraphState.State;

export function initialAgentGraphState(messages: Msg[], compactionWatermark = 0): AgentGraphStateValue {
  return {
    messages,
    text: '',
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    compacted: false,
    compactionWatermark,
    calls: [],
    continueModel: true,
  };
}
