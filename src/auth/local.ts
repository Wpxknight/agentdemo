import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { AuthProvider } from './provider.js';
import type { RequestContext, Role, User } from './types.js';
import { hashPassword, verifyPassword } from './password.js';
import { signSession, verifySession } from './session.js';

const log = logger.child({ mod: 'auth' });

export interface LocalAuthOptions {
  store: Store;
  /** JWT 签名密钥（HS256）。 */
  secret: string;
  /** token 有效期，jose 时间字符串，默认 '12h'。 */
  ttl?: string;
}

/** 本地认证：用户存 DB（scrypt 口令哈希），会话用 HS256 JWT。 */
export class LocalAuthProvider implements AuthProvider {
  private readonly store: Store;
  private readonly secret: Uint8Array;
  private readonly ttl: string;

  constructor(opts: LocalAuthOptions) {
    this.store = opts.store;
    this.secret = new TextEncoder().encode(opts.secret);
    this.ttl = opts.ttl ?? '12h';
  }

  /** 建号（平台/租户管理用）。 */
  async createUser(
    tenantId: string,
    username: string,
    password: string,
    role: Role,
  ): Promise<User> {
    const passwordHash = await hashPassword(password);
    return this.store.createUser({ tenantId, username, role, passwordHash });
  }

  async login(tenantId: string, username: string, password: string): Promise<string | undefined> {
    const user = await this.store.getUserByUsername(tenantId, username);
    if (!user) {
      log.warn({ tenantId, username }, 'login: 用户不存在');
      return undefined;
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      log.warn({ tenantId, username }, 'login: 口令错误');
      return undefined;
    }
    return signSession(this.secret, { tenantId: user.tenantId, userId: user.id, role: user.role }, this.ttl);
  }

  async authenticate(token: string): Promise<RequestContext | undefined> {
    return verifySession(this.secret, token);
  }
}
