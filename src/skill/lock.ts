import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2';

export interface SkillMutationLock {
  withLock<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T>;
  tryAcquireSlot?(keyPrefix: string, limit: number): Promise<(() => Promise<void>) | undefined>;
  tryAcquireSlots?(
    slots: readonly { keyPrefix: string; limit: number }[],
  ): Promise<(() => Promise<void>) | undefined>;
  close?(): Promise<void>;
}

/** MySQL advisory locks are scoped to one dedicated connection and auto-release on connection death. */
export class MysqlSkillMutationLock implements SkillMutationLock {
  constructor(private readonly pool: Pool) {}

  async withLock<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    const connection = await this.pool.promise().getConnection();
    const lockName = `aiop-skill:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
    let acquired = false;
    let reusable = true;
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [
        lockName,
        Math.max(1, Math.ceil(timeoutMs / 1000)),
      ]);
      acquired = Number((rows as Array<{ acquired: number | null }>)[0]?.acquired) === 1;
      if (!acquired) throw new Error(`获取技能分布式锁超时：${key}`);
      return await operation();
    } finally {
      if (acquired) {
        try {
          const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
          reusable = Number((rows as Array<{ released: number | null }>)[0]?.released) === 1;
        } catch {
          reusable = false;
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
    const connection = await this.pool.promise().getConnection();
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
}
