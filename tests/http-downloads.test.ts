import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/server/http.js';
import { DownloadStore } from '../src/server/downloads.js';
import type { Runtime } from '../src/runtime.js';

let server: Server;
let base: string;
let store: DownloadStore;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiop-http-dl-'));
  store = new DownloadStore({ dir, secret: 'test-secret' });
  const rt = { jwtSecret: 'test-secret', downloads: store } as unknown as Runtime;
  server = createHttpServer(rt);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('GET /v1/files/:token', () => {
  it('serves a saved file as an attachment without a Bearer header', async () => {
    const { url } = await store.save(Buffer.from('col1,col2\n1,2\n'), {
      name: '季度报表.csv',
      mime: 'text/csv; charset=utf-8',
      sessionId: 's1',
    });
    const r = await fetch(`${base}${url}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const cd = r.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('季度报表.csv')}`);
    expect(await r.text()).toBe('col1,col2\n1,2\n');
  });

  it('returns 404 for an invalid token', async () => {
    const r = await fetch(`${base}/v1/files/not-a-valid-token`);
    expect(r.status).toBe(404);
  });
});
