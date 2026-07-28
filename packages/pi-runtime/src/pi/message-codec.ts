import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  CompatibleAgentMessage,
  CompatibleContentBlock,
  PiContentExtension,
} from './compatibility.js';

const KNOWN_CONTENT_TYPES = new Set(['text', 'image', 'toolCall']);

export class MessageCodec {
  toPi(message: CompatibleAgentMessage): AgentMessage {
    const { extensions, ...base } = message;
    if (!extensions?.length || typeof base.content === 'string') return base as AgentMessage;
    const content: unknown[] = [...base.content];
    for (const extension of extensions) {
      const index = extension.index ?? content.length;
      content.splice(Math.min(Math.max(0, index), content.length), 0, extension.value);
    }
    return { ...base, content } as AgentMessage;
  }

  fromPi(message: AgentMessage): CompatibleAgentMessage {
    const source = message as AgentMessage & { content?: unknown };
    const base = { ...source };
    if (!('content' in source) || typeof source.content === 'string' || !Array.isArray(source.content)) {
      return base as CompatibleAgentMessage;
    }
    const content: CompatibleContentBlock[] = [];
    const extensions: PiContentExtension[] = [];
    for (const [index, block] of source.content.entries()) {
      if (isKnownContentBlock(block)) content.push(block);
      else extensions.push({
        version: 1,
        kind: 'pi_content_block',
        value: block,
        ...(content.length || index < source.content.length - 1 ? { index } : {}),
      });
    }
    return {
      ...base,
      content,
      ...(extensions.length ? { extensions } : {}),
    } as CompatibleAgentMessage;
  }
}

function isKnownContentBlock(value: unknown): value is CompatibleContentBlock {
  return Boolean(value && typeof value === 'object'
    && 'type' in value && typeof value.type === 'string' && KNOWN_CONTENT_TYPES.has(value.type));
}
