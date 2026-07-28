import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
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
    const cloned = structuredClone(message) as Message & { content?: unknown };
    if (!('content' in cloned) || typeof cloned.content === 'string' || !Array.isArray(cloned.content)) {
      return cloned as CompatibleAgentMessage;
    }
    const content: CompatibleContentBlock[] = [];
    const extensions: PiContentExtension[] = [];
    for (const [index, block] of cloned.content.entries()) {
      if (isKnownContentBlock(block)) content.push(block);
      else extensions.push({
        version: 1,
        kind: 'pi_content_block',
        value: block,
        ...(content.length || index < cloned.content.length - 1 ? { index } : {}),
      });
    }
    return {
      ...cloned,
      content,
      ...(extensions.length ? { extensions } : {}),
    } as CompatibleAgentMessage;
  }
}

function isKnownContentBlock(value: unknown): value is CompatibleContentBlock {
  return Boolean(value && typeof value === 'object'
    && 'type' in value && typeof value.type === 'string' && KNOWN_CONTENT_TYPES.has(value.type));
}
