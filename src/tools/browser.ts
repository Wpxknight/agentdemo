import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { DesktopHandle } from '../sandbox/desktop.js';

/** 按上下文取（必要时创建）一个桌面会话。 */
export type DesktopResolver = (ctx: ToolContext) => Promise<DesktopHandle>;

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function reqNumber(o: Record<string, JsonValue>, key: string): number {
  const v = o[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 ${key} 必须是数字`);
  return n;
}

/**
 * 远端桌面 / 浏览器工具（computer-use 风格）。
 * 截图返回元信息 + 流地址（多模态回传超出当前文本消息格式，前端可经 stream URL 观察）。
 */
export function buildBrowserTools(resolve: DesktopResolver): ToolHandler[] {
  return [
    {
      def: {
        name: 'desktop_stream_url',
        description: '启动远端桌面流并返回 noVNC 页面 URL（前端 iframe 可观看/操作）。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx): Promise<ToolResult> {
        const d = await resolve(ctx);
        const url = await d.startStream();
        return { id: '', content: `桌面流地址：${url}` };
      },
    },
    {
      def: {
        name: 'browser_navigate',
        description: '在远端桌面浏览器中打开指定 URL（启动 Chrome）。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要打开的网址' } },
          required: ['url'],
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const url = typeof o.url === 'string' ? o.url : '';
        if (!url) return { id: '', content: 'url 必填', isError: true };
        const d = await resolve(ctx);
        await d.launch('google-chrome', url);
        return { id: '', content: `已在浏览器打开：${url}` };
      },
    },
    {
      def: {
        name: 'browser_click',
        description: '在远端桌面坐标 (x,y) 处左键点击。',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const x = reqNumber(o, 'x');
        const y = reqNumber(o, 'y');
        const d = await resolve(ctx);
        await d.leftClick(x, y);
        return { id: '', content: `已点击 (${x}, ${y})` };
      },
    },
    {
      def: {
        name: 'browser_type',
        description: '在远端桌面当前焦点处键入文本。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const text = typeof o.text === 'string' ? o.text : '';
        const d = await resolve(ctx);
        await d.write(text);
        return { id: '', content: `已输入 ${text.length} 个字符` };
      },
    },
    {
      def: {
        name: 'browser_screenshot',
        description: '截取远端桌面画面；返回字节数与流地址（图像可经桌面流查看）。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx): Promise<ToolResult> {
        const d = await resolve(ctx);
        const png = await d.screenshot();
        return { id: '', content: `截图已捕获（${png.byteLength} 字节）。桌面流：${d.streamUrl()}` };
      },
    },
  ];
}
