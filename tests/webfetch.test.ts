import { describe, expect, it } from 'vitest';
import { buildWebFetchTool, htmlToText } from '../src/tools/webfetch.js';

const ctx = { sessionId: 's1' };

describe('htmlToText', () => {
  it('strips scripts/styles/tags and decodes entities', () => {
    const html = '<html><head><style>x{}</style><script>bad()</script></head><body><h1>标题</h1><p>a &amp; b</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('标题');
    expect(text).toContain('a & b');
    expect(text).not.toContain('bad()');
    expect(text).not.toContain('<');
  });
});

describe('web_fetch tool guards', () => {
  it('rejects non-http protocol', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.run({ url: 'file:///etc/passwd' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('仅支持 http/https');
  });

  it('rejects loopback address (SSRF guard)', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.run({ url: 'http://127.0.0.1/admin' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('私网');
  });

  it('rejects host outside allowlist', async () => {
    const tool = buildWebFetchTool({ allowedDomains: ['docs.example.com'] });
    const r = await tool.run({ url: 'http://evil.com/' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('白名单');
  });

  it('requires url', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.run({}, ctx);
    expect(r.isError).toBe(true);
  });
});
