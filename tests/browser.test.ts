import { describe, expect, it, vi } from 'vitest';
import type { DesktopHandle } from '@aiop/sandbox-runtime';
import { buildBrowserTools } from '../src/tools/browser.js';

describe('desktop_stream_url', () => {
  it('keeps the sandbox data URL out of model-facing text', async () => {
    const dataUrl = `data:text/html;charset=utf-8,${'preview'.repeat(20_000)}`;
    const desktop: DesktopHandle = {
      sandboxId: 'desktop-1',
      startStream: vi.fn(async () => dataUrl),
      streamUrl: vi.fn(() => dataUrl),
      launch: vi.fn(async () => {}),
      leftClick: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      screenshot: vi.fn(async () => new Uint8Array()),
      kill: vi.fn(async () => {}),
    };
    const tool = buildBrowserTools(async () => desktop)
      .find((candidate) => candidate.name === 'desktop_stream_url')!;

    const result = await tool.execute({}, { sessionId: 'weather session' });

    expect(result.content).toBe('浏览器预览地址：/v1/browser/stream-view?sessionId=weather%20session');
    expect(result.content).not.toContain('data:');
    expect(desktop.startStream).toHaveBeenCalledOnce();
  });
});

describe('browser_screenshot', () => {
  it('keeps screenshot data out of model-facing text while preserving the image block', async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const imageData = Buffer.from(image).toString('base64');
    const dataUrl = `data:text/html;charset=utf-8,${imageData.repeat(20_000)}`;
    const desktop: DesktopHandle = {
      sandboxId: 'desktop-1',
      startStream: vi.fn(async () => dataUrl),
      streamUrl: vi.fn(() => dataUrl),
      launch: vi.fn(async () => {}),
      leftClick: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      screenshot: vi.fn(async () => image),
      kill: vi.fn(async () => {}),
    };
    const tool = buildBrowserTools(async () => desktop)
      .find((candidate) => candidate.name === 'browser_screenshot')!;

    const result = await tool.execute({}, { sessionId: 'session-1' });

    expect(result.content).toBe('截图已捕获（4 字节）。');
    expect(result.content).not.toContain('data:');
    expect(result.contentBlocks).toEqual([
      { type: 'text', text: '截图已捕获（4 字节）。' },
      { type: 'image', mimeType: 'image/png', data: imageData },
    ]);
    expect(desktop.streamUrl).not.toHaveBeenCalled();
  });
});
