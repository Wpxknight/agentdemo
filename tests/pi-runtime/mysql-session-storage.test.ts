import { describe, expect, it } from 'vitest';
import type { SessionStorage } from '@earendil-works/pi-agent-core';
import { PiMysqlSessionStorage } from '../../packages/pi-runtime/src/index.js';

describe('PiMysqlSessionStorage public contract', () => {
  it('implements every Pi 0.82.1 SessionStorage method', () => {
    const methods: Array<keyof SessionStorage> = [
      'getMetadata', 'getLeafId', 'setLeafId', 'createEntryId', 'appendEntry', 'getEntry',
      'findEntries', 'getLabel', 'getSessionName', 'getSessionStats', 'getPathToRootOrCompaction', 'getEntries',
    ];
    for (const method of methods) expect(typeof PiMysqlSessionStorage.prototype[method]).toBe('function');
  });
});
