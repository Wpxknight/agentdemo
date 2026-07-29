import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix, relative, resolve, sep } from 'node:path';
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
  if (input.sbx.supportsSecretFiles === false && input.sbx.writeFile) {
    return syncLocalSkillFiles(input, result);
  }
  if (!kept.length) return { ...result, error: '没有可同步的文件（可能全部被大小过滤跳过）' };
  if (total > SYNC_TOTAL_BYTES) return { ...result, error: '待同步文件总量超过上限；请用 paths 参数缩小同步范围' };

  const { stdout: archive } = await execFileAsync(
    'tar', ['-C', input.dir, '-czf', '-', ...kept.map((file) => file.path)],
    { maxBuffer: SYNC_TOTAL_BYTES * 2, encoding: 'buffer' },
  );
  const b64 = archive.toString('base64');
  const tmp = input.sbx.workspacePath?.(`.aiop-tmp/aiop-skill-${safe}`)
    ?? `/tmp/aiop-skill-${safe}`;
  const tmpDir = posix.dirname(tmp);
  const prep = await input.sbx.runCommand(
    `command -v tar >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 || { echo AIOP_MISSING_TOOLS; exit 9; }; `
      + (input.partial ? '' : `rm -rf '${dest}'; `)
      + `mkdir -p '${dest}' '${tmpDir}' && rm -f '${tmp}.b64' '${tmp}.tgz'`,
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

async function syncLocalSkillFiles(
  input: {
    dir: string;
    partial: boolean;
    sbx: SandboxHandle;
  },
  result: Omit<SandboxSyncResult, 'error'>,
): Promise<SandboxSyncResult> {
  const writeSandboxFile = input.sbx.writeFile;
  if (!writeSandboxFile) return { ...result, error: '本地沙箱不支持安全文件上传' };
  try {
    const prepared: Array<{ file: SkillFileEntry; content: Uint8Array }> = [];
    const actualSkipped = [...result.skipped];
    let actualTotal = 0;
    for (const file of result.kept) {
      const source = resolve(input.dir, file.path);
      const relativeSource = relative(resolve(input.dir), source);
      if (relativeSource === '..' || relativeSource.startsWith(`..${sep}`) || relativeSource === '') {
        throw new Error('技能同步源路径越界');
      }
      const content = await readFile(source);
      const actualFile = { ...file, size: content.byteLength };
      if (!input.partial && content.byteLength > SYNC_SKIP_FILE_BYTES) {
        actualSkipped.push(actualFile);
        continue;
      }
      actualTotal += content.byteLength;
      if (actualTotal > SYNC_TOTAL_BYTES) {
        return { ...result, kept: prepared.map((item) => item.file), skipped: actualSkipped,
          total: actualTotal, error: '待同步文件总量超过上限；请用 paths 参数缩小同步范围' };
      }
      prepared.push({ file: actualFile, content });
    }
    if (!prepared.length) {
      return { ...result, kept: [], skipped: actualSkipped, total: 0,
        error: '没有可同步的文件（可能全部被大小过滤跳过）' };
    }
    if (!input.sbx.reserveSyncGeneration) {
      return { ...result, kept: prepared.map((item) => item.file), skipped: actualSkipped,
        total: actualTotal, error: '本地沙箱不支持同步配额预留' };
    }
    try {
      await input.sbx.reserveSyncGeneration(actualTotal);
    } catch (error) {
      return { ...result, kept: prepared.map((item) => item.file), skipped: actualSkipped,
        total: actualTotal, error: `本地沙箱同步配额不足：${String(error)}` };
    }
    const actualResult = {
      ...result,
      dest: posix.join(result.dest, randomUUID()),
      kept: prepared.map((item) => item.file),
      skipped: actualSkipped,
      total: actualTotal,
    };
    for (const item of prepared) {
      await writeSandboxFile.call(input.sbx, posix.join(actualResult.dest, item.file.path), item.content);
    }
    return actualResult;
  } catch (error) {
    return { ...result, error: `沙箱文件写入失败：${String(error)}` };
  }
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
