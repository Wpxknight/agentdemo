import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { MemoryCheckpointStore, MysqlCheckpointSaver } from '../src/agent/checkpoint/mysql.js';
import { validate } from '@langchain/langgraph-checkpoint-validation';

Object.assign(globalThis, {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
});

validate({
  checkpointerName: 'AIoP MysqlCheckpointSaver protocol',
  createCheckpointer: () => new MysqlCheckpointSaver(new MemoryCheckpointStore()),
});

function checkpoint(id: string, value: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { value },
    channel_versions: { value: 1 },
    versions_seen: {},
  };
}

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

function config(threadId: string, checkpointId?: string) {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      tenant_id: 'tenant-a',
      run_id: threadId,
      graph_name: 'aiop-agent',
      graph_version: 'v1',
    },
  };
}

describe('MysqlCheckpointSaver protocol', () => {
  it('stores checkpoints, parent links, pending writes, and lists newest first', async () => {
    const saver = new MysqlCheckpointSaver(new MemoryCheckpointStore());
    const firstConfig = await saver.put(config('run-a'), checkpoint('0001', 'first'), metadata, { value: 1 });
    const secondConfig = await saver.put(firstConfig, checkpoint('0002', 'second'), { ...metadata, step: 2 }, { value: 2 });
    await saver.putWrites(secondConfig, [['tool-result', { ok: true }]], 'task-1');

    const latest = await saver.getTuple(config('run-a'));
    expect(latest?.checkpoint.channel_values).toEqual({ value: 'second' });
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe('0001');
    expect(latest?.pendingWrites).toEqual([['task-1', 'tool-result', { ok: true }]]);

    const listed = [];
    for await (const tuple of saver.list(config('run-a'))) listed.push(tuple.checkpoint.id);
    expect(listed).toEqual(['0002', '0001']);
  });

  it('isolates threads and deletes checkpoints with their writes', async () => {
    const saver = new MysqlCheckpointSaver(new MemoryCheckpointStore());
    const a = await saver.put(config('run-a'), checkpoint('0001', 'a'), metadata, { value: 1 });
    const b = await saver.put(config('run-b'), checkpoint('0001', 'b'), metadata, { value: 1 });
    await saver.putWrites(a, [['x', 1]], 'task-a');
    await saver.putWrites(b, [['x', 2]], 'task-b');

    await saver.deleteThread('run-a');

    await expect(saver.getTuple(config('run-a'))).resolves.toBeUndefined();
    expect((await saver.getTuple(config('run-b')))?.checkpoint.channel_values).toEqual({ value: 'b' });
  });
});
