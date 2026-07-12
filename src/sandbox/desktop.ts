/**
 * 远端浏览器预览 + computer-use 操作抽象。
 * 工具只依赖这些接口，由 E2bDesktopProvider（@e2b/desktop）或测试 mock 实现。
 */

export interface DesktopSpec {
  key: string;
  profile?: string;
  sandboxId?: string;
  template?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  metadata?: Record<string, string>;
  envs?: Record<string, string>;
  timeoutMs?: number;
}

export interface DesktopHandle {
  readonly sandboxId: string;
  /** 启动浏览器预览，返回前端 iframe 渲染的页面 URL。 */
  startStream(): Promise<string>;
  streamUrl(): string;
  /** 启动应用（如 google-chrome）并可选打开 URL。 */
  launch(application: string, uri?: string): Promise<void>;
  /** 远端浏览器当前页面 URL（用户可在本地浏览器新标签页直接打开）；后端不支持时缺省。 */
  currentUrl?(): Promise<string>;
  leftClick(x: number, y: number): Promise<void>;
  write(text: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  kill(): Promise<void>;
}

export interface DesktopProvider {
  create(spec: DesktopSpec): Promise<DesktopHandle>;
  connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}
