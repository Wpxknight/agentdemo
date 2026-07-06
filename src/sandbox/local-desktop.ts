import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
  ].filter(Boolean) as string[];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    if (res.status === 0) return cmd;
  }
  throw new Error('未找到本机 Chrome/Chromium，无法启用本地浏览器工具');
}

class CdpClient {
  private seq = 0;
  private pending = new Map<number, Pending>();

  private constructor(private readonly ws: any) {
    ws.addEventListener('message', (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8');
      const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed'));
      else waiter.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP websocket closed'));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
      if (!WebSocketCtor) {
        reject(new Error('当前 Node 运行时不支持 WebSocket'));
        return;
      }
      const ws: any = new WebSocketCtor(url);
      ws.addEventListener('open', () => resolve(new CdpClient(ws)));
      ws.addEventListener('error', () => reject(new Error('连接 Chrome DevTools 失败')));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close(): void {
    this.ws.close();
  }
}

interface TargetInfo {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class LocalDesktopHandle implements DesktopHandle {
  readonly sandboxId: string;
  private dir = '';
  private proc?: ChildProcess;
  private debugPort = 0;
  private stream = 'data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3EChrome%20not%20started%3C%2Fbody%3E%3C%2Fhtml%3E';

  constructor(private readonly key: string, private readonly timeoutMs = 60_000) {
    this.sandboxId = `local-desktop-${key.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  }

  async startStream(): Promise<string> {
    await this.ensureChrome();
    this.updateStream(await this.capturePng());
    return this.stream;
  }

  streamUrl(): string {
    return this.stream;
  }

  async launch(_application: string, uri?: string): Promise<void> {
    await this.ensureChrome();
    if (!uri) return;
    await this.withPage(async (page) => {
      await page.send('Page.enable');
      await page.send('Page.navigate', { url: uri });
      await delay(900);
    });
  }

  async leftClick(x: number, y: number): Promise<void> {
    await this.ensureChrome();
    await this.withPage(async (page) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    });
  }

  async write(text: string): Promise<void> {
    await this.ensureChrome();
    await this.withPage(async (page) => {
      await page.send('Input.insertText', { text });
    });
  }

  async screenshot(): Promise<Uint8Array> {
    await this.ensureChrome();
    const png = await this.capturePng();
    this.updateStream(png);
    return png;
  }

  private async capturePng(): Promise<Uint8Array> {
    // 用 JPEG + quality 截图：截图对模型是 token 大头（尤其按字节计费的模型），
    // JPEG 比无损 PNG 小一个数量级，直接降低上下文占用。
    const result = await this.withPage(async (page) => {
      await page.send('Page.enable');
      return page.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false });
    }) as { data?: string };
    return Buffer.from(result.data || '', 'base64');
  }

  private updateStream(png: Uint8Array): void {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><style>body{margin:0;background:#0f172a;color:#d6e2ff;font:14px sans-serif}header{padding:10px 12px;border-bottom:1px solid #263449}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><header>Local browser preview · ${new Date().toLocaleTimeString()}</header><img src="data:image/jpeg;base64,${Buffer.from(png).toString('base64')}" /></body></html>`;
    this.stream = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  async kill(): Promise<void> {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
    this.proc = undefined;
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = '';
  }

  private async ensureChrome(): Promise<void> {
    if (this.proc && this.debugPort) return;
    const chrome = findChrome();
    this.dir = await mkdtemp(path.join(tmpdir(), 'aiop-local-chrome-'));
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${path.join(this.dir, 'profile')}`,
      '--window-size=1280,900',
      'about:blank',
    ];
    this.proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = this.proc.stderr;
    if (!stderr) throw new Error('无法读取 Chrome 启动日志');
    stderr.setEncoding('utf8');
    const deadline = Date.now() + Math.min(this.timeoutMs, 15_000);
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`本地 Chrome 启动失败，退出码 ${this.proc.exitCode}`);
      const chunk = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(''), 250);
        stderr.once('data', (data) => {
          clearTimeout(timer);
          resolve(String(data));
        });
      });
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(chunk);
      if (match) {
        this.debugPort = Number(match[1]);
        return;
      }
    }
    throw new Error('本地 Chrome 启动超时');
  }

  private async pageTarget(): Promise<TargetInfo> {
    await this.ensureChrome();
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`);
      const targets = await response.json() as TargetInfo[];
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
      await delay(100);
    }
    throw new Error('未找到 Chrome 页面 target');
  }

  private async withPage<T>(fn: (page: CdpClient) => Promise<T>): Promise<T> {
    const target = await this.pageTarget();
    const page = await CdpClient.connect(target.webSocketDebuggerUrl!);
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  }
}

export class LocalDesktopProvider implements DesktopProvider {
  async create(spec: DesktopSpec): Promise<DesktopHandle> {
    return new LocalDesktopHandle(spec.key, spec.timeoutMs);
  }

  async connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle> {
    return new LocalDesktopHandle(sandboxId || spec.key, spec.timeoutMs);
  }
}
