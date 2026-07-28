import { describe, expect, it } from 'vitest';
import type { JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionMetadata } from '@earendil-works/pi-agent-core';
import type { PiAgentSessionFactory } from '../../packages/pi-runtime/src/index.js';

declare const jsonlFactory: PiAgentSessionFactory<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>;
declare const events: Parameters<typeof jsonlFactory.create>[0]['events'];

describe('Pi runtime create typing', () => {
  it('requires repository-specific create fields', () => {
    if (false) {
      // @ts-expect-error JsonlSessionRepo create requires cwd.
      void jsonlFactory.create({ initialMessage: { role: 'user', text: 'start' }, events });
      void jsonlFactory.create({ session: { cwd: '/tmp' }, initialMessage: { role: 'user', text: 'start' }, events });
    }
    expect(true).toBe(true);
  });
});
