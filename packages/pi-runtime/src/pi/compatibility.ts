import type { Usage } from '@earendil-works/pi-ai';

export type CompatibleContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

export interface PiContentExtension {
  version: 1;
  kind: 'pi_content_block';
  value: unknown;
  index?: number;
}

export type CompatibleAgentMessage =
  | {
      role: 'user';
      content: string | CompatibleContentBlock[];
      timestamp: number;
      extensions?: PiContentExtension[];
    }
  | {
      role: 'assistant';
      content: CompatibleContentBlock[];
      api: string;
      provider: string;
      model: string;
      responseModel?: string;
      responseId?: string;
      diagnostics?: unknown[];
      usage: Usage;
      stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
      errorMessage?: string;
      timestamp: number;
      extensions?: PiContentExtension[];
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: CompatibleContentBlock[];
      details?: unknown;
      usage?: Usage;
      addedToolNames?: string[];
      isError: boolean;
      timestamp: number;
      extensions?: PiContentExtension[];
    };
