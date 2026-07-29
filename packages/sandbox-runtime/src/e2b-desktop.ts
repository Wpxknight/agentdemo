import { Sandbox as Desktop } from '@e2b/desktop';
import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';

export interface E2bDesktopOptions {
  apiKey?: string;
  domain?: string;
}

class E2bDesktopHandle implements DesktopHandle {
  constructor(private readonly d: Desktop) {}

  get sandboxId(): string {
    return this.d.sandboxId;
  }

  async startStream(): Promise<string> {
    await this.d.stream.start();
    return this.d.stream.getUrl();
  }

  streamUrl(): string {
    return this.d.stream.getUrl();
  }

  async launch(application: string, uri?: string): Promise<void> {
    await this.d.launch(application, uri);
  }

  async leftClick(x: number, y: number): Promise<void> {
    await this.d.leftClick(x, y);
  }

  async write(text: string): Promise<void> {
    await this.d.write(text);
  }

  async screenshot(): Promise<Uint8Array> {
    return this.d.screenshot();
  }

  async kill(): Promise<void> {
    await this.d.kill();
  }
}

/** 基于 @e2b/desktop 的远端桌面后端。 */
export class E2bDesktopProvider implements DesktopProvider {
  constructor(private readonly opts: E2bDesktopOptions = {}) {}

  private connectOpts(spec: DesktopSpec) {
    return { apiKey: this.opts.apiKey ?? process.env.E2B_API_KEY, domain: this.opts.domain };
  }

  async create(spec: DesktopSpec): Promise<DesktopHandle> {
    const d = await Desktop.create({ ...this.connectOpts(spec), timeoutMs: spec.timeoutMs });
    return new E2bDesktopHandle(d);
  }

  async connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle> {
    const d = await Desktop.connect(sandboxId, this.connectOpts(spec));
    if (spec.timeoutMs) await d.setTimeout(spec.timeoutMs);
    return new E2bDesktopHandle(d);
  }
}
