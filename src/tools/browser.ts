import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { DesktopHandle } from '../sandbox/desktop.js';

/** 按上下文取（必要时创建）一个浏览器会话。 */
export type DesktopResolver = (ctx: ToolContext) => Promise<DesktopHandle>;

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/** 按魔数识别截图格式（不同 provider 可能返回 JPEG 或 PNG）。 */
function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  return 'image/png';
}

function reqNumber(o: Record<string, JsonValue>, key: string): number {
  const v = o[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 ${key} 必须是数字`);
  return n;
}

/**
 * 远端浏览器工具（computer-use 风格）。
 * 截图返回元信息 + 预览地址（多模态回传超出当前文本消息格式，前端可经 stream URL 观察）。
 */
export function buildBrowserTools(resolve: DesktopResolver): ToolHandler[] {
  return [
    {
      def: {
        name: 'desktop_stream_url',
        description: '启动远端浏览器预览并返回 iframe 页面 URL。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx): Promise<ToolResult> {
        const d = await resolve(ctx);
        const url = await d.startStream();
        return { id: '', content: `浏览器预览地址：${url}` };
      },
    },
    {
      def: {
        name: 'browser_navigate',
        description: '在远端浏览器中打开指定 URL（启动 Chrome）。',
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
        description: '在远端浏览器坐标 (x,y) 处左键点击。',
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
        description: '在远端浏览器当前焦点处键入文本；文本以换行符结尾时额外按一次回车（提交表单/搜索）。',
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
        name: 'browser_current_url',
        description: '获取远端浏览器当前页面的 URL；用户可在本地浏览器新标签页直接打开该地址操作。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx): Promise<ToolResult> {
        const d = await resolve(ctx);
        if (!d.currentUrl) return { id: '', content: '当前沙箱后端不支持获取页面地址', isError: true };
        const url = await d.currentUrl();
        // chrome://intro、about:blank 等内部页对用户无意义，只放行 http(s)。
        if (!url || !/^https?:\/\//i.test(url)) return { id: '', content: '浏览器尚未打开任何页面' };
        return { id: '', content: `当前页面：${url}` };
      },
    },
    {
      def: {
        name: 'browser_screenshot',
        description: '截取远端浏览器画面；返回字节数与预览地址。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx): Promise<ToolResult> {
        const d = await resolve(ctx);
        const img = await d.screenshot();
        const text = `截图已捕获（${img.byteLength} 字节）。浏览器预览：${d.streamUrl()}`;
        return {
          id: '',
          content: text,
          contentBlocks: [
            { type: 'text', text },
            { type: 'image', mimeType: sniffImageMime(img), data: Buffer.from(img).toString('base64') },
          ],
        };
      },
    },
  ];
}
