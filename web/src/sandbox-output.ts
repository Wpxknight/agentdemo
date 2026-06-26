export type SandboxOutputKind = 'command' | 'stdout' | 'stderr' | 'error';

export interface SandboxOutputEntry {
  id: string;
  kind: SandboxOutputKind;
  text: string;
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
    entries.push({ id: `${entries.length}-${nextKind}`, kind: nextKind, text });
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
    if (/^(运行失败|预览获取失败|截图失败|连接中断)/.test(line)) {
      kind = 'error';
    }
    push(kind, line);
  }
  return entries;
}

function truncateOutputLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
