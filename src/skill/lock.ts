import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2';

export const SKILL_IMPORT_GLOBAL_CONCURRENCY = 4;
export const SKILL_IMPORT_TENANT_CONCURRENCY = 2;
const DEFAULT_CONNECTION_ACQUIRE_TIMEOUT_MS = 10_000;

export function skillImportPermitPoolSize(configuredPoolSize: number): number {
  return Math.max(configuredPoolSize, SKILL_IMPORT_GLOBAL_CONCURRENCY + 1);
}

export interface SkillMutationLock {
  withLock<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T>;
  withLocks?<T>(keys: readonly string[], timeoutMs: number, operation: () => Promise<T>): Promise<T>;
  tryAcquireSlot?(keyPrefix: string, limit: number): Promise<(() => Promise<void>) | undefined>;
  tryAcquireSlots?(
    slots: readonly { keyPrefix: string; limit: number }[],
  ): Promise<(() => Promise<void>) | undefined>;
  close?(): Promise<void>;
}

/** MySQL advisory locks are scoped to one dedicated connection and auto-release on connection death. */
export class MysqlSkillMutationLock implements SkillMutationLock {
  constructor(
    private readonly pool: Pool,
    private readonly connectionAcquireTimeoutMs = DEFAULT_CONNECTION_ACQUIRE_TIMEOUT_MS,
  ) {}

  async withLock<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([key], timeoutMs, operation);
  }

  async withLocks<T>(keys: readonly string[], timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    const connection = await this.getConnection();
    const orderedKeys = [...new Set(keys)].sort();
    const acquiredLockNames: string[] = [];
    let reusable = true;
    const deadline = Date.now() + timeoutMs;
    try {
      for (const key of orderedKeys) {
        const lockName = `aiop-skill:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
        const remainingMs = Math.max(0, deadline - Date.now());
        const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [
          lockName,
          Math.max(1, Math.ceil(remainingMs / 1000)),
        ]);
        if (Number((rows as Array<{ acquired: number | null }>)[0]?.acquired) !== 1) {
          throw new Error(`获取技能分布式锁超时：${key}`);
        }
        acquiredLockNames.push(lockName);
      }
      return await operation();
    } finally {
      for (const lockName of acquiredLockNames.reverse()) {
        try {
          const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
          if (Number((rows as Array<{ released: number | null }>)[0]?.released) !== 1) reusable = false;
        } catch {
          reusable = false;
          break;
        }
      }
      if (reusable) connection.release();
      else connection.destroy();
    }
  }

  async close(): Promise<void> {
    await this.pool.promise().end();
  }

  async tryAcquireSlot(keyPrefix: string, limit: number): Promise<(() => Promise<void>) | undefined> {
    return this.tryAcquireSlots([{ keyPrefix, limit }]);
  }

  async tryAcquireSlots(
    slots: readonly { keyPrefix: string; limit: number }[],
  ): Promise<(() => Promise<void>) | undefined> {
    const connection = await this.getConnection();
    const acquiredLockNames: string[] = [];
    try {
      for (const { keyPrefix, limit } of slots) {
        let acquiredLockName: string | undefined;
        for (let index = 0; index < limit; index += 1) {
          const lockName = `aiop-skill:${createHash('sha256').update(`${keyPrefix}:${index}`).digest('hex').slice(0, 48)}`;
          const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
          if (Number((rows as Array<{ acquired: number | null }>)[0]?.acquired) === 1) {
            acquiredLockName = lockName;
            acquiredLockNames.push(lockName);
            break;
          }
        }
        if (!acquiredLockName) {
          let reusable = true;
          for (const lockName of acquiredLockNames.reverse()) {
            try {
              const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
              if (Number((rows as Array<{ released: number | null }>)[0]?.released) !== 1) reusable = false;
            } catch {
              reusable = false;
              break;
            }
          }
          if (reusable) connection.release();
          else connection.destroy();
          return undefined;
        }
      }
    } catch (error) {
      connection.destroy();
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      let reusable = true;
      for (const lockName of acquiredLockNames.reverse()) {
        try {
          const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
          if (Number((rows as Array<{ released: number | null }>)[0]?.released) !== 1) reusable = false;
        } catch {
          reusable = false;
          break;
        }
      }
      if (reusable) connection.release();
      else connection.destroy();
    };
  }

  private async getConnection(): Promise<Awaited<ReturnType<ReturnType<Pool['promise']>['getConnection']>>> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.pool.promise().getConnection().then((connection) => {
      if (timedOut) {
        connection.release();
        throw new Error('获取技能锁连接超时');
      }
      return connection;
    });
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('获取技能锁连接超时'));
          }, this.connectionAcquireTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
