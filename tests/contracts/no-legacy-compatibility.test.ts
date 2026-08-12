import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('new-project compatibility boundary', () => {
  it('does not ship migration-era runtime or configuration surfaces', async () => {
    const source = await sourceBundle(['src', 'packages']);
    const forbidden = [
      'interface AgentRuntime',
      'interface AgentKernel',
      'class AgentRunCoordinator',
      'LegacyToolHandler',
      'summaryBudget',
      'nameLockTimeoutMs',
      'CompatibleAgentMessage',
      'legacy-seed-governance-v1',
      'legacyProfile(',
      'createCompatibilityAIOPToolRuntime',
      'summaries(): string',
      'includeLegacy',
      'legacyPayload',
    ];

    for (const token of forbidden) expect(source, token).not.toContain(token);
  });

  it('uses a current baseline plus a focused scheduler upgrade without legacy runtime markers', async () => {
    const directory = resolve(root, 'src/db/migrations');
    const migrations = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    expect(migrations).toEqual([
      '0001_baseline.sql',
      '0002_scheduler_schema_upgrade.sql',
      '0003_positive_user_ids.sql',
      '0004_oidc_exchange_codes.sql',
    ]);
    const sources = await Promise.all(migrations.map((migration) => readFile(join(directory, migration), 'utf8')));
    expect(sources.join('\n')).not.toMatch(/legacy-v1|compat-v1|langgraph/i);
  });
});

async function sourceBundle(roots: string[]): Promise<string> {
  const files = (await Promise.all(roots.map((directory) => productionFiles(resolve(root, directory))))).flat();
  return (await Promise.all(files.map(async (file) => {
    const name = relative(root, file).split(sep).join('/');
    return `// ${name}\n${await readFile(file, 'utf8')}`;
  }))).join('\n');
}

async function productionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['bin', 'dist', 'node_modules'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|sql)$/.test(entry.name)) files.push(path);
  }
  return files;
}
