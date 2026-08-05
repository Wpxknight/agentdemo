import type { Msg, ToolContentBlock } from './types.js';

/**
 * 上下文管理：在发送给模型前把历史裁剪 / 压缩到 token 预算内，避免超出模型上下文窗口（400）。
 *
 * 分三层（本模块提供纯逻辑，摘要压缩的模型调用在调用方）：
 * 1. keep-last-K：仅保留最近 K 条带图消息的图片，更早的截图替换为占位文本（截图是 token 大头）。
 * 2. 硬预算裁剪：仍超预算则从最旧消息成对丢弃（保序、保工具配对、保最后一条）。
 * 3. 摘要压缩：`planCompaction` 给出"待摘要的旧消息 + 保留的近消息"，调用方用模型把旧消息总结成一段后拼回。
 */

const CHARS_PER_TOKEN = 4;
/** 图片 token 估算：Anthropic 约 (宽×高)/750；对按字节计费的模型（如经代理的 kimi）则 base64 长度/4 更准 —— 取两者较大值，两种口径都安全。 */
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_OMITTED_PLACEHOLDER = '[图像已从历史上下文中省略以节省 token]';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
/** 发送给模型前为输出预留的 token（思考开启时 Anthropic 默认 max_tokens 32000）。 */
export const OUTPUT_TOKEN_RESERVE = 32000;
/** 上下文预算安全余量：吸收估算误差（尤其中文字符 token 密度高于 chars/4）。 */
export const CONTEXT_SAFETY_MARGIN = 16000;

/** 发送给模型前压缩历史的 token 预算 = 上下文窗口 − 输出预留 − 安全余量。 */
export function contextBudgetTokens(windowTokens: number = DEFAULT_CONTEXT_WINDOW_TOKENS): number {
  return Math.max(20000, windowTokens - OUTPUT_TOKEN_RESERVE - CONTEXT_SAFETY_MARGIN);
}

/** 自动摘要压缩产生的历史摘要消息前缀（前端据此识别并特殊展示）。 */
export const SUMMARY_PREFIX = '【历史对话摘要（自动压缩，供参考）】\n';

/** 把摘要文本包装成回填历史用的 user 消息。 */
export function summaryMessage(summary: string): Msg {
  return { role: 'user', text: SUMMARY_PREFIX + summary };
}

/**
 * 是否用户的真实输入（压缩时原样保留、永不摘要吞掉）：
 * user 角色、带正文或附件，且不是历史摘要消息本身（摘要以 user 角色落库）。
 */
export function isUserInputMsg(msg: Msg): boolean {
  return msg.role === 'user'
    && !msg.toolResults?.length
    && Boolean(msg.text?.trim() || msg.contentBlocks?.length)
    && !(msg.text ?? '').startsWith(SUMMARY_PREFIX);
}

/** 从 base64 图片数据里读出像素尺寸（仅 PNG / JPEG，失败返回 undefined）。 */
export function imageDimensions(base64: string): { width: number; height: number } | undefined {
  const buf = Buffer.from(base64, 'base64');
  // PNG：\x89PNG，IHDR 宽高在偏移 16/20（大端 4 字节）。
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：\xFF\xD8，扫描 SOF0/2 段（0xFFC0..0xFFCF，除 C4/C8/CC）取宽高。
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // 0xFF 填充字节 / 无长度段（SOI、RST0-7、EOI、TEM）：跳过，不能按段长读。
      if (marker === 0xff) { off++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return undefined;
}

/** 估算单张图片 token：max(像素/750, base64 长度/4)。 */
function imageTokens(block: Extract<ToolContentBlock, { type: 'image' }>): number {
  const dims = imageDimensions(block.data);
  const pixelTokens = dims ? Math.ceil((dims.width * dims.height) / IMAGE_PIXELS_PER_TOKEN) : 0;
  const byteTokens = Math.ceil(block.data.length / CHARS_PER_TOKEN);
  return Math.max(pixelTokens, byteTokens);
}

/** 估算单条消息的 token 数（图片按上面口径计，文本按 chars/4）。 */
export function estimateMsgTokens(msg: Msg): number {
  let chars = 0;
  let imgTokens = 0;
  chars += msg.text?.length ?? 0;
  chars += msg.thinking?.length ?? 0;
  for (const b of msg.thinkingBlocks ?? []) chars += b.thinking.length + b.signature.length;
  if (msg.toolCalls) chars += JSON.stringify(msg.toolCalls).length;
  for (const block of msg.contentBlocks ?? []) {
    if (block.type === 'image') imgTokens += imageTokens(block);
    else chars += block.text.length;
  }
  for (const result of msg.toolResults ?? []) {
    chars += result.content.length;
    for (const block of result.contentBlocks ?? []) {
      if (block.type === 'image') imgTokens += imageTokens(block);
      else chars += block.text.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + imgTokens;
}

/** 估算整段消息的 token 数。 */
export function estimateTokens(messages: Msg[]): number {
  return messages.reduce((total, msg) => total + estimateMsgTokens(msg), 0);
}

function blocksHaveImage(blocks?: ToolContentBlock[]): boolean {
  return Boolean(blocks?.some((b) => b.type === 'image'));
}

function hasImage(msg: Msg): boolean {
  return blocksHaveImage(msg.contentBlocks)
    || Boolean(msg.toolResults?.some((r) => blocksHaveImage(r.contentBlocks)));
}

function replaceImageBlocks(blocks: ToolContentBlock[]): ToolContentBlock[] {
  return blocks.map((b) => (b.type === 'image' ? { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER } : b));
}

/** 把某条消息里的图片块（用户附件 + 工具结果）替换为占位文本，保留其余块 / 文本回退。 */
function stripImages(msg: Msg): Msg {
  let next = msg;
  if (blocksHaveImage(msg.contentBlocks)) {
    next = { ...next, contentBlocks: replaceImageBlocks(msg.contentBlocks!) };
  }
  if (msg.toolResults?.some((r) => blocksHaveImage(r.contentBlocks))) {
    next = {
      ...next,
      toolResults: msg.toolResults.map((result) =>
        blocksHaveImage(result.contentBlocks)
          ? { ...result, contentBlocks: replaceImageBlocks(result.contentBlocks!) }
          : result,
      ),
    };
  }
  return next;
}

/**
 * 硬预算裁剪：把历史压缩到 budgetTokens 以内，返回**新数组**（不修改入参）。
 * - keepImages：保留最近多少条带图消息的图片（其余替换占位符），默认 1。
 * - budgetTokens <= 0 时不裁剪，仅按 keepImages 剥离旧图。
 * - 裁剪后保证首条为 user 消息（Anthropic 要求首条 user，孤儿 tool 结果也会 400）。
 */
export function compactMessages(messages: Msg[], budgetTokens: number, keepImages = 1): Msg[] {
  if (messages.length === 0) return messages;

  // 1. 仅保留最近 keepImages 条带图消息的图片，其余替换占位符。
  // 注意 slice(-0) 会返回整个数组，keepImages<=0 必须显式给空集（一张不留）。
  const imageIdx: number[] = [];
  messages.forEach((msg, i) => {
    if (hasImage(msg)) imageIdx.push(i);
  });
  const keep = new Set(keepImages > 0 ? imageIdx.slice(-keepImages) : []);
  let msgs = messages.map((msg, i) => (keep.has(i) || !hasImage(msg) ? msg : stripImages(msg)));

  if (budgetTokens > 0) {
    // 2. 单条超大消息截断：整条丢弃救不了“单条就超预算”（最后一条永不丢弃）。
    const capTokens = perMessageCapTokens(budgetTokens);
    msgs = msgs.map((msg) => truncateOversizedMsg(msg, capTokens));

    // 3. 仍超预算则从最旧丢弃，始终保留最后一条；避免首条为孤儿 tool 结果。
    // 逐条估算一次后增量扣减，避免每丢一条就全量重估（长历史 O(n²)）。
    const tokens = msgs.map(estimateMsgTokens);
    let total = tokens.reduce((a, b) => a + b, 0);
    let start = 0;
    while (msgs.length - start > 1 && total > budgetTokens) {
      total -= tokens[start++];
      while (msgs.length - start > 1 && msgs[start].role === 'tool') total -= tokens[start++];
    }
    // 4. 发生过丢弃时首条必须是 user（Anthropic 400）：assistant/tool 开头继续丢；
    // 只剩一条非 user 时降级转成 user 文本。未裁剪的历史原样返回。
    if (start) {
      let out = msgs.slice(start);
      while (out.length > 1 && out[0].role !== 'user') out = out.slice(1);
      if (out[0].role !== 'user') out = [asUserFallback(out[0])];
      return out;
    }
    return msgs;
  }
  return msgs;
}

/** 单条消息 token 上限：预算的 1/4，至少 2000 —— 单条不该独占整个预算。 */
function perMessageCapTokens(budgetTokens: number): number {
  return Math.max(2000, Math.floor(budgetTokens / 4));
}

/** 截断时每个文本字段的保底长度，避免按比例缩到只剩几个字。 */
const TRUNCATE_MIN_KEEP_CHARS = 500;

/**
 * 把单条超过 capTokens 的消息按比例截断文本字段。
 * 只截文本（正文 / 文本块 / 工具结果）：思考块截断会破坏签名校验，图片由 keep-last-K 治理。
 */
function truncateOversizedMsg(msg: Msg, capTokens: number): Msg {
  if (estimateMsgTokens(msg) <= capTokens) return msg;
  const capChars = capTokens * CHARS_PER_TOKEN;
  const totalChars = textFieldChars(msg);
  if (totalChars <= capChars) return msg; // 超额来自图片/思考块，文本无可截
  const ratio = capChars / totalChars;
  const cut = (text: string): string =>
    truncate(text, Math.max(TRUNCATE_MIN_KEEP_CHARS, Math.floor(text.length * ratio)));
  const cutBlocks = (blocks?: ToolContentBlock[]): ToolContentBlock[] | undefined =>
    blocks?.map((b) => (b.type === 'text' ? { ...b, text: cut(b.text) } : b));
  return {
    ...msg,
    ...(msg.text ? { text: cut(msg.text) } : {}),
    ...(msg.contentBlocks ? { contentBlocks: cutBlocks(msg.contentBlocks) } : {}),
    ...(msg.toolResults
      ? {
          toolResults: msg.toolResults.map((r) => ({
            ...r,
            content: cut(r.content),
            ...(r.contentBlocks ? { contentBlocks: cutBlocks(r.contentBlocks) } : {}),
          })),
        }
      : {}),
  };
}

function textFieldChars(msg: Msg): number {
  let chars = msg.text?.length ?? 0;
  for (const b of msg.contentBlocks ?? []) if (b.type === 'text') chars += b.text.length;
  for (const r of msg.toolResults ?? []) {
    chars += r.content.length;
    for (const b of r.contentBlocks ?? []) if (b.type === 'text') chars += b.text.length;
  }
  return chars;
}

/** 仅剩一条非 user 消息时的降级：转成 user 文本，保住内容且不触发协议校验错误。 */
function asUserFallback(msg: Msg): Msg {
  const parts = [msg.text ?? '', ...(msg.toolResults ?? []).map((r) => r.content)].filter(Boolean);
  return { role: 'user', text: `[早前${msg.role === 'tool' ? '工具结果' : '助手回复'}]\n${parts.join('\n')}` };
}

/**
 * 摘要压缩规划：把历史切成"待摘要的旧消息 stale"和"原样保留的近消息 recent"。
 * - keepRecent：保留最近多少条消息不摘要。
 * - 保证 recent 不以孤儿 tool 结果开头（否则工具配对断裂）。
 * - 若无需压缩（消息数 <= keepRecent），stale 为空。
 */
export function planCompaction(messages: Msg[], keepRecent: number): { stale: Msg[]; recent: Msg[] } {
  const k = Math.max(1, keepRecent);
  if (messages.length <= k) return { stale: [], recent: messages };
  let cut = messages.length - k;
  // recent 不能以 tool 结果开头：把切点往前挪，让对应的 assistant(toolCalls) 一起进 recent。
  while (cut > 0 && messages[cut]?.role === 'tool') cut--;
  return { stale: messages.slice(0, cut), recent: messages.slice(cut) };
}

/**
 * 把待摘要的消息渲染成**纯文本**（喂给模型做摘要），图片替换占位符、超长内容截断，
 * 避免摘要请求本身又超窗。
 * - 消息正文（可能内联超长附件）与工具结果都按 maxCharsPerResult 截断；
 * - 总长再按 maxTotalChars 兜底，超出时丢最旧的部分（stale 尾部离当前对话更近，更值得保留）。
 */
export function renderForSummary(messages: Msg[], maxCharsPerResult = 4000, maxTotalChars = 120_000): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.text?.trim()) {
      const imageNote = blocksHaveImage(msg.contentBlocks) ? '[含图片附件]' : '';
      lines.push(`${roleLabel(msg.role)}${imageNote}：${truncate(msg.text.trim(), maxCharsPerResult)}`);
    }
    for (const call of msg.toolCalls ?? []) {
      lines.push(`工具调用 ${call.name}(${truncate(JSON.stringify(call.args), 500)})`);
    }
    for (const result of msg.toolResults ?? []) {
      const imageNote = blocksHaveImage(result.contentBlocks) ? '[含截图]' : '';
      lines.push(`工具结果${imageNote}：${truncate(result.content, maxCharsPerResult)}`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= maxTotalChars) return text;
  return `（更早的 ${text.length - maxTotalChars} 字已省略）\n…${text.slice(-maxTotalChars)}`;
}

function roleLabel(role: Msg['role']): string {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : '工具';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断 ${text.length - max} 字）`;
}
