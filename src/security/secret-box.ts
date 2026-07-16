import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger.js';

const CIPHER = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;

/** AES-256-GCM 密文盒；domain 用于密钥域隔离，密文格式不包含 secret。 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, domain: string) {
    if (!secret.trim()) throw new Error('设置加密 secret 不能为空');
    if (!domain.trim()) throw new Error('设置加密 domain 不能为空');
    this.key = createHash('sha256').update(`aiop-secret-box:${domain}:${secret}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  open(envelope: string): string {
    try {
      const [version, ivRaw, tagRaw, dataRaw, extra] = envelope.split(':');
      if (version !== ENVELOPE_VERSION || !ivRaw || !tagRaw || !dataRaw || extra !== undefined) throw new Error();
      const iv = Buffer.from(ivRaw, 'base64');
      const tag = Buffer.from(tagRaw, 'base64');
      if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv(CIPHER, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('设置凭据无法解密，请重新配置');
    }
  }
}

/** 设置 secret 优先独立变量；为兼容开发环境可临时回退 JWT secret。 */
export function createSettingsSecretBox(env: NodeJS.ProcessEnv = process.env): SecretBox {
  const settingsSecret = env.AIOP_SETTINGS_SECRET?.trim();
  if (settingsSecret) return new SecretBox(settingsSecret, 'platform-settings');

  const fallback = env.AIOP_JWT_SECRET?.trim();
  if (fallback) {
    logger.warn('AIOP_SETTINGS_SECRET 未设置，开发兼容模式回退 AIOP_JWT_SECRET；生产环境必须配置独立 secret');
    return new SecretBox(fallback, 'platform-settings');
  }

  logger.warn('AIOP_SETTINGS_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  return new SecretBox('dev-insecure-settings-secret', 'platform-settings');
}
