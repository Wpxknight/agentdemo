import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface ImportSkillZipOptions {
  rootDir: string;
  filename: string;
  data: Buffer;
}

export interface ImportSkillZipResult {
  skillDir: string;
  files: string[];
}

interface ZipEntry {
  path: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_ENTRIES = 2_048;
const MAX_ZIP_ENTRY_BYTES = 16_000_000;
const MAX_ZIP_TOTAL_BYTES = 64_000_000;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

export async function importSkillZip(options: ImportSkillZipOptions): Promise<ImportSkillZipResult> {
  if (!/\.zip$/i.test(options.filename)) throw new Error('仅支持导入 zip 技能包');
  const entries = readZipEntries(options.data);
  if (!entries.length) throw new Error('zip 技能包为空');

  const hasRootFile = entries.some((entry) => !entry.path.includes('/'));
  const topLevels = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean));
  const preserveTopDirectory = !hasRootFile && topLevels.size === 1;
  const topDirectory = preserveTopDirectory ? [...topLevels][0]! : '';
  const rootDir = resolve(options.rootDir);
  const targetDir = preserveTopDirectory
    ? safeResolve(rootDir, topDirectory)
    : safeResolve(rootDir, skillDirName(options.filename));

  await mkdir(targetDir, { recursive: true });

  const written: string[] = [];
  for (const entry of entries) {
    const relativePath = preserveTopDirectory
      ? entry.path
      : posix.join(skillDirName(options.filename), entry.path);
    const destination = safeResolve(rootDir, relativePath);
    await mkdir(posixDirnameForFs(destination), { recursive: true });
    await writeFile(destination, entry.data);
    written.push(preserveTopDirectory ? entry.path.slice(topDirectory.length + 1) : entry.path);
  }

  await readFile(join(targetDir, 'SKILL.md'), 'utf8').catch(() => {
    throw new Error('技能包缺少 SKILL.md');
  });

  return {
    skillDir: targetDir,
    files: written.sort(),
  };
}

function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocdOffset = findEocd(zip);
  if (eocdOffset < 0) throw new Error('zip 文件格式无效');
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error('zip 条目数量超过上限');
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > zip.length) throw new Error('zip 中央目录无效');

  const entries: ZipEntry[] = [];
  let totalUncompressedSize = 0;
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('zip 中央目录条目无效');
    }
    const versionMadeBy = zip.readUInt16LE(offset + 4);
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nextOffset > zip.length) throw new Error('zip 中央目录条目越界');

    const rawName = zip.subarray(nameStart, nameEnd).toString('utf8');
    const entryPath = safeZipPath(rawName);
    offset = nextOffset;
    if (!entryPath) continue;
    if (flags & 0x1) throw new Error('不支持加密 zip 条目');
    if (method !== 0 && method !== 8) throw new Error(`不支持的 zip 压缩方式：${method}`);
    const unixMode = externalAttributes >>> 16;
    if ((versionMadeBy >>> 8) === 3 && (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
      throw new Error('技能包不允许符号链接');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 技能包');
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error('zip 单文件超过解压大小上限');
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_ZIP_TOTAL_BYTES) throw new Error('zip 超过解压总大小上限');
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error('zip 本地文件头无效');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new Error('zip 文件数据越界');

    const compressed = zip.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) throw new Error('zip 文件大小校验失败');
    entries.push({ path: entryPath, data });
  }
  return entries;
}

function findEocd(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= minOffset; offset--) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function safeZipPath(rawPath: string): string | undefined {
  const normalizedSlashes = rawPath.replace(/\\/g, '/');
  if (!normalizedSlashes || normalizedSlashes.includes('\0')) throw new Error('非法 zip 路径');
  if (normalizedSlashes.endsWith('/')) {
    validateZipPath(normalizedSlashes.slice(0, -1));
    return undefined;
  }
  return validateZipPath(normalizedSlashes);
}

function validateZipPath(path: string): string {
  if (!path || path.startsWith('/') || path.startsWith('//') || /^[A-Za-z]:\//.test(path)) {
    throw new Error('非法 zip 路径');
  }
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('非法 zip 路径');
  }
  const normalized = posix.normalize(parts.join('/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('非法 zip 路径');
  }
  return normalized;
}

function skillDirName(filename: string): string {
  const base = basename(filename, extname(filename))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return base || 'imported-skill';
}

function safeResolve(rootDir: string, relativePath: string): string {
  const target = resolve(rootDir, relativePath);
  if (target !== rootDir && !target.startsWith(`${rootDir}${sep}`)) {
    throw new Error('非法 zip 路径');
  }
  return target;
}

function posixDirnameForFs(path: string): string {
  return path.slice(0, path.lastIndexOf(sep)) || sep;
}
