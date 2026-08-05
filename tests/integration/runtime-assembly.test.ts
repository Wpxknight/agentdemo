import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/index.js';
import { MemoryStore } from '../../src/db/memory.js';
import { buildRuntime } from '../../src/runtime.js';
import type { Config } from '../../src/config/schema.js';

const root = resolve(import.meta.dirname, '../..');
const retiredPackages = [
  'agent-kernel-pi',
  'agent-runtime-core',
  'agent-runtime-mysql',
  'agent-runtime-aiop',
  'tool-runtime',
  'skill-runtime',
] as const;
const targetPackages = [
  'control-contracts',
  'mcp-runtime',
  'pi-runtime',
  'sandbox-runtime',
  'scheduler-runtime',
] as const;

async function productionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'bin' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.isFile() && /\.(?:ts|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function sourceBundle(): Promise<string> {
  const roots = [resolve(root, 'src'), resolve(root, 'packages'), resolve(root, 'scripts')];
  const files = (await Promise.all(roots.map(productionFiles))).flat();
  files.push(resolve(root, 'package.json'), resolve(root, 'package-lock.json'), resolve(root, 'tsconfig.packages.json'));
  return (await Promise.all(files.map(async (file) => {
    const name = relative(root, file).split(sep).join('/');
    return `// ${name}\n${await readFile(file, 'utf8')}`;
  }))).join('\n');
}

describe('final runtime assembly boundary', () => {
  it('ships exactly the five target runtime packages', async () => {
    const packages = (await readdir(resolve(root, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(packages).toEqual([...targetPackages].sort());
  });

  it('does not reference retired packages or duplicate root runtimes', async () => {
    const source = await sourceBundle();
    for (const name of retiredPackages) expect(source).not.toContain(`@aiop/${name}`);
    expect(source).not.toContain('// src/model/');
    expect(source).not.toContain('SessionCommitter');
    expect(source).not.toContain('createConfiguredAgentRuntime');
  });

  it('removes retired root source trees instead of preserving shims', async () => {
    const retiredPaths = [
      'src/agent/pi',
      'src/agent/runtime.ts',
      'src/agent/context.ts',
      'src/agent/services',
      'src/model',
      'src/mcp',
    ];
    for (const path of retiredPaths) {
      await expect(stat(resolve(root, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps packages independent from the root application source', async () => {
    const source = (await Promise.all(
      (await productionFiles(resolve(root, 'packages'))).map((file) => readFile(file, 'utf8')),
    )).join('\n');
    expect(source).not.toMatch(/(?:from|import\()\s*['"][^'"]*(?:\.\.\/)+(?:src|\.\.\/src)\//);
  });

  it('serializes database migrations with a connection-scoped advisory lock', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql === 'SELECT version FROM schema_migrations') {
          return [[{ version: 1 }], []];
        }
        return [[], []];
      },
      release: () => statements.push({ sql: 'connection.release()' }),
    };
    const pool = {
      promise: () => ({ getConnection: async () => connection }),
    };

    await runMigrations(pool as never);

    expect(statements[0]).toMatchObject({ sql: 'SELECT GET_LOCK(?, ?) AS acquired' });
    expect(statements[0]?.values?.[0]).toBe('aiop:schema-migrations');
    expect(statements.at(-2)).toMatchObject({ sql: 'SELECT RELEASE_LOCK(?) AS released' });
    expect(statements.at(-1)).toEqual({ sql: 'connection.release()' });
  });

  it('releases the connection without running migrations when the advisory lock is not acquired', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (sql: string) => {
        statements.push(sql);
        return sql.includes('GET_LOCK') ? [[{ acquired: 0 }], []] : [[], []];
      },
      release: () => statements.push('connection.release()'),
    };
    const pool = { promise: () => ({ getConnection: async () => connection }) };

    await expect(runMigrations(pool as never)).rejects.toThrow('Timed out waiting for the schema migration lock');

    expect(statements).toEqual(['SELECT GET_LOCK(?, ?) AS acquired', 'connection.release()']);
  });

  it.each([0, null])(
    'destroys the migration connection when RELEASE_LOCK returns %s',
    async (released) => {
      const lifecycle: string[] = [];
      const connection = {
        query: async (sql: string) => {
          if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
          if (sql.includes('RELEASE_LOCK')) return [[{ released }], []];
          if (sql === 'SELECT version FROM schema_migrations') {
            return [[...Array.from({ length: 26 }, (_, index) => ({ version: index + 1 }))], []];
          }
          return [[], []];
        },
        release: () => lifecycle.push('release'),
        destroy: () => lifecycle.push('destroy'),
      };
      const pool = { promise: () => ({ getConnection: async () => connection }) };

      await runMigrations(pool as never);

      expect(lifecycle).toEqual(['destroy']);
    },
  );

  it('destroys the migration connection when RELEASE_LOCK throws', async () => {
    const lifecycle: string[] = [];
    const connection = {
      query: async (sql: string) => {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) throw new Error('release query failed');
        if (sql === 'SELECT version FROM schema_migrations') {
          return [[...Array.from({ length: 26 }, (_, index) => ({ version: index + 1 }))], []];
        }
        return [[], []];
      },
      release: () => lifecycle.push('release'),
      destroy: () => lifecycle.push('destroy'),
    };
    const pool = { promise: () => ({ getConnection: async () => connection }) };

    await runMigrations(pool as never);

    expect(lifecycle).toEqual(['destroy']);
  });

  it('assembles one mandatory durable runtime for non-MySQL application modes', async () => {
    const config: Config = {
      models: {
        default: {
          protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'test-model',
        },
      },
      defaultModel: 'default',
    };
    const runtime = await buildRuntime(config, { store: new MemoryStore() });
    try {
      expect(runtime.durableRunRuntime).toMatchObject({
        run: expect.any(Function), resume: expect.any(Function), cancel: expect.any(Function), append: expect.any(Function),
      });
      expect(runtime).not.toHaveProperty('agentRuntime');
    } finally {
      await runtime.dispose();
    }
  });
});
