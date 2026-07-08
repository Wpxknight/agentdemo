import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'downloads' });

/** 导出文件的元信息（随下载令牌签发，不落库）。 */
export interface DownloadMeta {
  /** 用户下载时看到的文件名。 */
  name: string;
  /** MIME 类型（决定 Content-Type）。 */
  mime: string;
  /** 归属租户（隔离，仅审计用途）。 */
  tenantId?: string;
  /** 归属会话。 */
  sessionId: string;
}

/** 由令牌解出的已就绪下载。 */
export interface OpenedDownload {
  meta: DownloadMeta;
  size: number;
  stream: Readable;
}

/** 导出工具依赖的最小写入面（便于单测 mock）。 */
export interface ExportSink {
  /** 单文件导出上限（字节）；超出应由调用方拒绝。 */
  readonly maxBytes: number;
  /** 下载链接有效期（毫秒）。 */
  readonly ttlMs: number;
  /** 保存字节并签发根相对下载链接。 */
  save(bytes: Uint8Array, meta: DownloadMeta): Promise<{ url: string; expiresAt: string }>;
}

export interface DownloadStoreOptions {
  /** 落盘目录。 */
  dir: string;
  /** 令牌签名密钥（与会话 JWT 同一 secret）。 */
  secret: string;
  /** 单文件上限（字节），默认 50 MiB。 */
  maxBytes?: number;
  /** 链接有效期（毫秒），默认 24 小时。 */
  ttlMs?: number;
  /** 下载路由前缀，默认 /v1/files。 */
  urlPrefix?: string;
  /** 可注入时钟，便于测试。 */
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FID_RE = /^[0-9a-f]{32}$/;

/**
 * 会话生成文件的下载中转：
 * - put 把字节落到中转目录（文件名 = 随机 fid）；
 * - 用签名 JWT 把 {fid,name,mime,...} 打包成能力令牌，下载链接即令牌本身
 *   （无需 Bearer 头，锚点点击即可下载）；
 * - 过期由 JWT exp + 周期 sweep 清理双重保证。
 */
export class DownloadStore implements ExportSink {
  readonly maxBytes: number;
  readonly ttlMs: number;
  private readonly dir: string;
  private readonly secret: Uint8Array;
  private readonly urlPrefix: string;
  private readonly now: () => number;
  private ready?: Promise<void>;

  constructor(opts: DownloadStoreOptions) {
    this.dir = opts.dir;
    this.secret = new TextEncoder().encode(opts.secret);
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.urlPrefix = (opts.urlPrefix ?? '/v1/files').replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
  }

  private ensureDir(): Promise<void> {
    if (!this.ready) this.ready = mkdir(this.dir, { recursive: true }).then(() => {});
    return this.ready;
  }

  async save(bytes: Uint8Array, meta: DownloadMeta): Promise<{ url: string; expiresAt: string }> {
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`文件超过下载上限（${bytes.byteLength} > ${this.maxBytes} 字节）`);
    }
    await this.ensureDir();
    const fid = randomBytes(16).toString('hex');
    await writeFile(join(this.dir, fid), bytes);
    const expMs = this.now() + this.ttlMs;
    const token = await new SignJWT({
      fid,
      name: meta.name,
      mime: meta.mime,
      tid: meta.tenantId,
      sid: meta.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(Math.floor(expMs / 1000))
      .sign(this.secret);
    return { url: `${this.urlPrefix}/${token}`, expiresAt: new Date(expMs).toISOString() };
  }

  /** 校验令牌并打开文件流；令牌无效 / 过期 / 文件不存在均返回 undefined。 */
  async open(token: string): Promise<OpenedDownload | undefined> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.secret, { currentDate: new Date(this.now()) }));
    } catch {
      return undefined;
    }
    const fid = payload.fid;
    if (typeof fid !== 'string' || !FID_RE.test(fid)) return undefined;
    const file = join(this.dir, fid);
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) return undefined;
      size = info.size;
    } catch {
      return undefined;
    }
    const meta: DownloadMeta = {
      name: typeof payload.name === 'string' ? payload.name : 'download',
      mime: typeof payload.mime === 'string' ? payload.mime : 'application/octet-stream',
      tenantId: typeof payload.tid === 'string' ? payload.tid : undefined,
      sessionId: typeof payload.sid === 'string' ? payload.sid : '',
    };
    return { meta, size, stream: createReadStream(file) };
  }

  /** 清理过期落盘文件（mtime 超过 ttl + 一小时宽限）。返回删除数量。 */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    const cutoff = this.now() - this.ttlMs - 60 * 60_000;
    let removed = 0;
    await Promise.all(
      names.map(async (name) => {
        const file = join(this.dir, name);
        try {
          const info = await stat(file);
          if (info.isFile() && info.mtimeMs <= cutoff) {
            await rm(file, { force: true });
            removed++;
          }
        } catch (err) {
          log.warn({ file, err: String(err) }, 'download sweep stat/rm failed');
        }
      }),
    );
    if (removed) log.info({ removed }, 'expired downloads reclaimed');
    return removed;
  }
}
