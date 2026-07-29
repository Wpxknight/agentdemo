import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxHandle } from '../sandbox/types.js';
import type { SkillFileEntry } from './product.js';

const execFileAsync = promisify(execFile);
export const SYNC_SKIP_FILE_BYTES = 2_000_000;
export const SYNC_TOTAL_BYTES = 16_000_000;
const SYNC_CHUNK_CHARS = 64_000;
const SANDBOX_SKILLS_ROOT = 'skills';

export interface SandboxSyncResult {
  dest: string;
  kept: SkillFileEntry[];
  skipped: SkillFileEntry[];
  total: number;
  error?: string;
}

export async function syncSkillToSandbox(input: {
  name: string;
  dir: string;
  files: SkillFileEntry[];
  partial: boolean;
  sbx: SandboxHandle;
}): Promise<SandboxSyncResult> {
  const kept = input.partial ? input.files : input.files.filter((file) => file.size <= SYNC_SKIP_FILE_BYTES);
  const skipped = input.partial ? [] : input.files.filter((file) => file.size > SYNC_SKIP_FILE_BYTES);
  const total = kept.reduce((sum, file) => sum + file.size, 0);
  const safe = input.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = input.sbx.workspacePath?.(`${SANDBOX_SKILLS_ROOT}/${safe}`)
    ?? `/workspace/${SANDBOX_SKILLS_ROOT}/${safe}`;
  const result = { dest, kept, skipped, total };
  if (!kept.length) return { ...result, error: '没有可同步的文件（可能全部被大小过滤跳过）' };
  if (total > SYNC_TOTAL_BYTES) return { ...result, error: '待同步文件总量超过上限；请用 paths 参数缩小同步范围' };

  const { stdout: archive } = await execFileAsync(
    'tar', ['-C', input.dir, '-czf', '-', ...kept.map((file) => file.path)],
    { maxBuffer: SYNC_TOTAL_BYTES * 2, encoding: 'buffer' },
  );
  const b64 = archive.toString('base64');
  const tmp = input.sbx.workspacePath?.(`.aiop-tmp/aiop-skill-${safe}`)
    ?? `/tmp/aiop-skill-${safe}`;
  const prep = await input.sbx.runCommand(
    `command -v tar >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 || { echo AIOP_MISSING_TOOLS; exit 9; }; `
      + (input.partial ? '' : `rm -rf '${dest}'; `)
      + `mkdir -p '${dest}' && rm -f '${tmp}.b64' '${tmp}.tgz'`,
  );
  if (failed(prep) || prep.stdout.includes('AIOP_MISSING_TOOLS')) {
    return { ...result, error: prep.stdout.includes('AIOP_MISSING_TOOLS')
      ? '沙箱缺少 tar/base64，无法同步；请改用 skill__read_file'
      : `沙箱准备失败：${execErrorText(prep)}` };
  }
  for (let offset = 0; offset < b64.length; offset += SYNC_CHUNK_CHARS) {
    await pushChunk(input.sbx, `${tmp}.b64`, b64.slice(offset, offset + SYNC_CHUNK_CHARS));
  }
  const unpack = await input.sbx.runCommand(
    `base64 -d '${tmp}.b64' > '${tmp}.tgz' && tar -xzf '${tmp}.tgz' -C '${dest}' `
      + `&& rm -f '${tmp}.b64' '${tmp}.tgz' && echo AIOP_SYNC_OK`,
  );
  if (failed(unpack) || !unpack.stdout.includes('AIOP_SYNC_OK')) {
    return { ...result, error: `沙箱解包失败：${execErrorText(unpack)}` };
  }
  return result;
}

async function pushChunk(sbx: SandboxHandle, path: string, chunk: string): Promise<void> {
  const first = await sbx.runCommand(`printf '%s' '${chunk}' >> '${path}'`);
  if (!failed(first)) return;
  const middle = Math.ceil(chunk.length / 2);
  for (const part of [chunk.slice(0, middle), chunk.slice(middle)]) {
    const retry = await sbx.runCommand(`printf '%s' '${part}' >> '${path}'`);
    if (failed(retry)) throw new Error(`分片写入沙箱失败：${execErrorText(retry)}`);
  }
}

function failed(result: { error?: string; exitCode?: number }): boolean {
  return Boolean(result.error) || (typeof result.exitCode === 'number' && result.exitCode !== 0);
}

function execErrorText(result: { error?: string; stderr: string; exitCode?: number }): string {
  return result.error || result.stderr.trim() || `exit code ${result.exitCode}`;
}
