export type SandboxOutputKind = 'command' | 'stdout' | 'stderr' | 'error';
export type SandboxAnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bright-black'
  | 'bright-red'
  | 'bright-green'
  | 'bright-yellow'
  | 'bright-blue'
  | 'bright-magenta'
  | 'bright-cyan'
  | 'bright-white';

export interface SandboxOutputSegment {
  text: string;
  className?: string;
  style?: {
    color?: string;
    backgroundColor?: string;
  };
}

export interface SandboxOutputEntry {
  id: string;
  kind: SandboxOutputKind;
  text: string;
  segments: SandboxOutputSegment[];
}

export const sandboxOutputClassNames: Record<SandboxOutputKind, string> = {
  command: 'sandbox-output-line command',
  stdout: 'sandbox-output-line stdout',
  stderr: 'sandbox-output-line stderr',
  error: 'sandbox-output-line error',
};

export const sandboxOutputLabels: Record<SandboxOutputKind, string> = {
  command: 'cmd',
  stdout: 'out',
  stderr: 'err',
  error: 'fail',
};

export function sandboxOutputCommand(language: string, code: string): string {
  return `run-code --language ${language} ${truncateOutputLine(code, 120)}`;
}

export function formatSandboxOutputChunk(stream: 'stdout' | 'stderr', text: string): string {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const marker = stream === 'stderr' ? '[stderr]' : '[stdout]';
  return `${marker}\n${normalized.endsWith('\n') ? normalized : `${normalized}\n`}`;
}

export function parseSandboxOutput(output: string): SandboxOutputEntry[] {
  const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
  if (!normalized.trim()) return [];
  const entries: SandboxOutputEntry[] = [];
  let kind: SandboxOutputKind = 'stdout';

  const push = (nextKind: SandboxOutputKind, text: string) => {
    const segments = parseAnsiSegments(text);
    entries.push({
      id: `${entries.length}-${nextKind}`,
      kind: nextKind,
      text: segments.map((segment) => segment.text).join(''),
      segments,
    });
  };

  for (const line of normalized.split('\n')) {
    if (line.startsWith('$ ')) {
      push('command', line.slice(2));
      kind = 'stdout';
      continue;
    }
    if (line === '[stdout]' || line.startsWith('[stdout]')) {
      kind = 'stdout';
      const rest = line.slice('[stdout]'.length).trim();
      if (rest) push(kind, rest);
      continue;
    }
    if (line === '[stderr]' || line.startsWith('[stderr]')) {
      kind = 'stderr';
      const rest = line.slice('[stderr]'.length).trim();
      if (rest) push(kind, rest);
      continue;
    }
    if (line === '[error]' || line.startsWith('[error]')) {
      kind = 'error';
      const rest = line.slice('[error]'.length).trim();
      if (rest) push(kind, rest);
      continue;
    }
    if (/^(运行失败|预览获取失败|截图失败|连接中断)/.test(stripAnsi(line))) {
      kind = 'error';
    }
    push(kind, line);
  }
  return entries;
}

const ANSI_CSI_PATTERN = /\u001b\[([0-9;?]*)([ -/]*)([@-~])/g;
const ANSI_COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const ANSI_16_RGB = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
] as const;

interface AnsiState {
  fg?: SandboxAnsiColor;
  bg?: SandboxAnsiColor;
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export function parseAnsiSegments(text: string): SandboxOutputSegment[] {
  const segments: SandboxOutputSegment[] = [];
  const state: AnsiState = {};
  let lastIndex = 0;

  const pushText = (value: string) => {
    if (!value) return;
    segments.push({ text: value, ...ansiStateProps(state) });
  };

  for (const match of text.matchAll(ANSI_CSI_PATTERN)) {
    pushText(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    if (match[3] !== 'm') continue;
    applySgrParams(parseSgrParams(match[1]), state);
  }

  pushText(text.slice(lastIndex));
  return segments.length ? segments : [{ text: '' }];
}

function stripAnsi(text: string): string {
  return parseAnsiSegments(text).map((segment) => segment.text).join('');
}

function parseSgrParams(raw: string): number[] {
  if (!raw) return [0];
  const params = raw.split(';').map((part) => Number(part || 0));
  return params.every((value) => Number.isFinite(value)) ? params : [0];
}

function applySgrParams(params: number[], state: AnsiState): void {
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) {
      resetAnsiState(state);
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 39) {
      state.fg = undefined;
      state.fgColor = undefined;
    } else if (code === 49) {
      state.bg = undefined;
      state.bgColor = undefined;
    } else if (code >= 30 && code <= 37) {
      state.fg = ANSI_COLOR_NAMES[code - 30];
      state.fgColor = undefined;
    } else if (code >= 40 && code <= 47) {
      state.bg = ANSI_COLOR_NAMES[code - 40];
      state.bgColor = undefined;
    } else if (code >= 90 && code <= 97) {
      state.fg = `bright-${ANSI_COLOR_NAMES[code - 90]}` as SandboxAnsiColor;
      state.fgColor = undefined;
    } else if (code >= 100 && code <= 107) {
      state.bg = `bright-${ANSI_COLOR_NAMES[code - 100]}` as SandboxAnsiColor;
      state.bgColor = undefined;
    } else if ((code === 38 || code === 48) && params[index + 1] === 5 && params[index + 2] !== undefined) {
      setExtendedAnsiColor(state, code, xtermColor(params[index + 2]));
      index += 2;
    } else if ((code === 38 || code === 48) && params[index + 1] === 2) {
      const rgb = params.slice(index + 2, index + 5);
      if (rgb.length === 3) setExtendedAnsiColor(state, code, `rgb(${rgb.map(clampRgb).join(', ')})`);
      index += 4;
    }
  }
}

function setExtendedAnsiColor(state: AnsiState, code: number, color: string): void {
  if (code === 38) {
    state.fg = undefined;
    state.fgColor = color;
  } else {
    state.bg = undefined;
    state.bgColor = color;
  }
}

function ansiStateProps(state: AnsiState): Pick<SandboxOutputSegment, 'className' | 'style'> {
  const classes = ['ansi-segment'];
  if (state.fg) classes.push(`ansi-fg-${state.fg}`);
  if (state.bg) classes.push(`ansi-bg-${state.bg}`);
  if (state.bold) classes.push('ansi-bold');
  if (state.dim) classes.push('ansi-dim');
  if (state.italic) classes.push('ansi-italic');
  if (state.underline) classes.push('ansi-underline');
  const style = {
    ...(state.fgColor ? { color: state.fgColor } : {}),
    ...(state.bgColor ? { backgroundColor: state.bgColor } : {}),
  };
  const hasStyle = Object.keys(style).length > 0;
  return classes.length > 1 || hasStyle ? { className: classes.join(' '), ...(hasStyle ? { style } : {}) } : {};
}

function resetAnsiState(state: AnsiState): void {
  state.fg = undefined;
  state.bg = undefined;
  state.fgColor = undefined;
  state.bgColor = undefined;
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
}

function xtermColor(value: number): string {
  const code = Math.max(0, Math.min(255, Math.trunc(value)));
  if (code < 16) return rgb(ANSI_16_RGB[code]);
  if (code >= 232) {
    const level = 8 + ((code - 232) * 10);
    return rgb([level, level, level]);
  }
  const offset = code - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return rgb([
    levels[Math.floor(offset / 36) % 6],
    levels[Math.floor(offset / 6) % 6],
    levels[offset % 6],
  ]);
}

function rgb(value: readonly number[]): string {
  return `rgb(${value.map(clampRgb).join(', ')})`;
}

function clampRgb(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value || 0)));
}

function truncateOutputLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
