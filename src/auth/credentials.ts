import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger.js';
import type { Store } from '../db/store.js';

const log = logger.child({ mod: 'credentials' });

/**
 * 用户下游平台凭据缓存（AIOS 集成 P3，DESIGN-aios-integration §3.2）：
 * - 与用户档案分离，随登录刷新、过期即失效；
 * - payload 以 AES-256-GCM 加密后交给 Store（MySQL 落库 / 内存），密钥由服务端 secret 派生；
 * - 明文永不落库、不进日志。
 */
export class UserCredentials {
  private readonly key: Buffer;

  constructor(private readonly store: Store, secret: string) {
    this.key = createHash('sha256').update(`aiop-credentials:${secret}`).digest();
  }

  /** 缓存某用户的下游凭据（payload 为任意 JSON 值，如 AIOS 的 {token, refreshToken, expiredTime}）。 */
  async set(tenantId: string, userId: string, provider: string, payload: unknown, expiresAt?: Date): Promise<void> {
    const encrypted = this.encrypt(JSON.stringify(payload));
    await this.store.setUserCredential(tenantId, userId, provider, { payload: encrypted, expiresAt });
  }

  /** 取回并解密；不存在或已过期返回 undefined。 */
  async get<T = unknown>(tenantId: string, userId: string, provider: string): Promise<T | undefined> {
    const rec = await this.store.getUserCredential(tenantId, userId, provider);
    if (!rec) return undefined;
    if (rec.expiresAt && rec.expiresAt.getTime() <= Date.now()) return undefined;
    try {
      return JSON.parse(this.decrypt(rec.payload)) as T;
    } catch (err) {
      // 解密失败（如 secret 轮换）视为无凭据，等下次登录刷新。
      log.warn({ tenantId, userId, provider, err: String(err) }, '凭据解密失败，视为缺失');
      return undefined;
    }
  }

  /** 清除某用户全部凭据（登出 / 软删除流程）。 */
  async clear(tenantId: string, userId: string): Promise<void> {
    await this.store.deleteUserCredentials(tenantId, userId);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
  }

  private decrypt(encrypted: string): string {
    const [version, ivB64, tagB64, dataB64] = encrypted.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('凭据密文格式无效');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
