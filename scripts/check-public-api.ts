import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packages = [
  'agent-contracts', 'agent-kernel-pi', 'agent-runtime-aiop', 'agent-runtime-core', 'agent-runtime-mysql',
  'mcp-runtime', 'sandbox-core', 'sandbox-e2b', 'sandbox-local', 'sandbox-opensandbox',
  'scheduler-core', 'scheduler-mysql', 'skill-runtime', 'tool-runtime',
];
const snapshotDir = resolve(root, 'docs/public-api');
const update = process.argv.includes('--update');

if (update) await mkdir(snapshotDir, { recursive: true });
const changed: string[] = [];
for (const name of packages) {
  const declaration = normalize(await readFile(resolve(root, 'packages', name, 'dist/index.d.ts'), 'utf8'));
  const snapshot = resolve(snapshotDir, `${name}.d.ts`);
  if (update) {
    await writeFile(snapshot, declaration);
    continue;
  }
  const expected = await readFile(snapshot, 'utf8').catch(() => '');
  if (expected !== declaration) changed.push(name);
}

if (changed.length) {
  throw new Error(`Public API snapshot changed: ${changed.join(', ')}. Review it, then run npm run check:public-api -- --update.`);
}

function normalize(source: string): string {
  return `${source.replace(/^\/\/\# sourceMappingURL=.*$/gm, '').trim()}\n`;
}
