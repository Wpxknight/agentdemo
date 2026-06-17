/**
 * 远端桌面（noVNC 流 + computer-use 操作）抽象。
 * 工具只依赖这些接口，由 E2bDesktopProvider（@e2b/desktop）或测试 mock 实现。
 */

export interface DesktopSpec {
  key: string;
  sandboxId?: string;
  timeoutMs?: number;
}

export interface DesktopHandle {
  readonly sandboxId: string;
  /** 启动桌面流，返回 noVNC 页面 URL（前端 iframe 渲染）。 */
  startStream(): Promise<string>;
  streamUrl(): string;
  /** 启动应用（如 google-chrome）并可选打开 URL。 */
  launch(application: string, uri?: string): Promise<void>;
  leftClick(x: number, y: number): Promise<void>;
  write(text: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  kill(): Promise<void>;
}

export interface DesktopProvider {
  create(spec: DesktopSpec): Promise<DesktopHandle>;
  connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}
