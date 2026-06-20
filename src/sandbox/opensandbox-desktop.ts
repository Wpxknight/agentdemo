import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';
import type { SandboxManager } from './lifecycle.js';
import type { ExecResult, SandboxHandle } from './types.js';

const WORK_DIR = '/tmp/aiop-browser';
const SCREENSHOT_MARKER = '__AIOP_SCREENSHOT__';

type CdpAction = 'navigate' | 'click' | 'type' | 'screenshot';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodePayload(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function execFailed(res: ExecResult): boolean {
  return Boolean(res.error) || (typeof res.exitCode === 'number' && res.exitCode !== 0);
}

function execDetails(res: ExecResult): string {
  return [
    res.error ? `error: ${res.error}` : '',
    res.stderr ? `stderr: ${res.stderr.trim()}` : '',
    res.stdout ? `stdout: ${res.stdout.trim()}` : '',
    typeof res.exitCode === 'number' ? `exitCode: ${res.exitCode}` : '',
  ].filter(Boolean).join('\n');
}

function assertOk(res: ExecResult, action: string): void {
  if (!execFailed(res)) return;
  throw new Error(`OpenSandbox browser ${action} failed\n${execDetails(res)}`);
}

function previewHtml(png?: Uint8Array): string {
  const body = png && png.byteLength
    ? `<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}" />`
    : '<main>OpenSandbox browser preview is ready.</main>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#d6e2ff;font:14px system-ui,sans-serif}header{padding:10px 12px;border-bottom:1px solid #263449}main{padding:16px}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><header>OpenSandbox browser preview</header>${body}</body></html>`;
}

const CDP_SCRIPT = String.raw`
const port = 9222;
const action = process.argv[2];
const rawPayload = process.argv[3] || 'e30';

function decodePayload(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(path, init) {
  const response = await fetch('http://127.0.0.1:' + port + path, init);
  if (!response.ok) {
    throw new Error('Chrome endpoint ' + path + ' returned HTTP ' + response.status);
  }
  return response.json();
}

async function ensurePageTarget() {
  for (let i = 0; i < 25; i++) {
    const targets = await requestJson('/json/list');
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    try {
      await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' });
    } catch {
      // Chrome may reject tab creation while it is still starting. Retry below.
    }
    await sleep(100);
  }
  throw new Error('No Chrome page target found');
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(raw);
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed'));
      else waiter.resolve(message.result || {});
    });
    ws.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP websocket closed'));
      this.pending.clear();
    });
  }

  static connect(url) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('Sandbox Node.js runtime does not provide global WebSocket');
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpClient(ws)));
      ws.addEventListener('error', () => reject(new Error('Failed to connect Chrome DevTools websocket')));
    });
  }

  send(method, params) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const payload = decodePayload(rawPayload);
  const target = await ensurePageTarget();
  const page = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await page.send('Page.enable');
    if (action === 'navigate') {
      await page.send('Page.navigate', { url: payload.url });
      await sleep(900);
      return;
    }
    if (action === 'click') {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: payload.x, y: payload.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: payload.x, y: payload.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: payload.x, y: payload.y, button: 'left', clickCount: 1 });
      return;
    }
    if (action === 'type') {
      await page.send('Input.insertText', { text: payload.text });
      return;
    }
    if (action === 'screenshot') {
      const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      console.log('__AIOP_SCREENSHOT__' + result.data);
      return;
    }
    throw new Error('Unknown browser action: ' + action);
  } finally {
    page.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

function chromeStartCommand(): string {
  return String.raw`set -e
mkdir -p /tmp/aiop-browser /tmp/aiop-browser/profile
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for OpenSandbox browser tools" >&2
  exit 127
fi
if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  exit 0
fi
CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium-browser || command -v chromium || command -v chrome || find /ms-playwright -path '*/chrome-linux*/chrome' -type f 2>/dev/null | head -n 1 || true)"
if [ -z "$CHROME_BIN" ]; then
  echo "chromium/google-chrome is required for OpenSandbox browser tools" >&2
  exit 127
fi
nohup "$CHROME_BIN" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/aiop-browser/profile \
  --window-size=1280,900 \
  about:blank >/tmp/aiop-browser/chrome.log 2>&1 &
echo $! >/tmp/aiop-browser/chrome.pid
for i in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.25
done
cat /tmp/aiop-browser/chrome.log >&2 || true
exit 1`;
}

class OpenSandboxDesktopHandle implements DesktopHandle {
  private chromeReady = false;
  private stream = `data:text/html;charset=utf-8,${encodeURIComponent(previewHtml())}`;

  constructor(private readonly handle: SandboxHandle) {}

  get sandboxId(): string {
    return this.handle.sandboxId;
  }

  async startStream(): Promise<string> {
    await this.ensureChrome();
    return this.stream;
  }

  streamUrl(): string {
    return this.stream;
  }

  async launch(_application: string, uri?: string): Promise<void> {
    await this.ensureChrome();
    if (uri) await this.runCdp('navigate', { url: uri });
  }

  async leftClick(x: number, y: number): Promise<void> {
    await this.runCdp('click', { x, y });
  }

  async write(text: string): Promise<void> {
    await this.runCdp('type', { text });
  }

  async screenshot(): Promise<Uint8Array> {
    const res = await this.runCdp('screenshot', {});
    const line = res.stdout.split(/\r?\n/).find((item) => item.startsWith(SCREENSHOT_MARKER));
    if (!line) throw new Error(`OpenSandbox browser screenshot did not return image data\n${execDetails(res)}`);
    const png = Buffer.from(line.slice(SCREENSHOT_MARKER.length), 'base64');
    this.stream = `data:text/html;charset=utf-8,${encodeURIComponent(previewHtml(png))}`;
    return png;
  }

  async kill(): Promise<void> {
    await this.handle.runCommand(
      `if [ -f ${WORK_DIR}/chrome.pid ]; then kill "$(cat ${WORK_DIR}/chrome.pid)" >/dev/null 2>&1 || true; fi`,
      { timeoutMs: 5_000 },
    ).catch(() => {});
    this.chromeReady = false;
  }

  private async ensureChrome(): Promise<void> {
    if (this.chromeReady) return;
    const res = await this.handle.runCommand(chromeStartCommand(), { timeoutMs: 30_000 });
    assertOk(res, 'start chrome');
    this.chromeReady = true;
  }

  private async runCdp(action: CdpAction, payload: Record<string, unknown>): Promise<ExecResult> {
    await this.ensureChrome();
    const command = [
      `node - ${shellQuote(action)} ${shellQuote(encodePayload(payload))} <<'AIOP_CDP'`,
      CDP_SCRIPT,
      'AIOP_CDP',
    ].join('\n');
    const res = await this.handle.runCommand(command, { timeoutMs: 15_000 });
    assertOk(res, action);
    return res;
  }
}

export class OpenSandboxDesktopProvider implements DesktopProvider {
  constructor(private readonly manager: SandboxManager) {}

  async create(spec: DesktopSpec): Promise<DesktopHandle> {
    const handle = await this.manager.get({ key: spec.key, timeoutMs: spec.timeoutMs });
    return new OpenSandboxDesktopHandle(handle);
  }

  async connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle> {
    const handle = await this.manager.get({ key: spec.key, sandboxId, timeoutMs: spec.timeoutMs });
    return new OpenSandboxDesktopHandle(handle);
  }
}
