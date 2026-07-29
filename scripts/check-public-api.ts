import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packages = [
  'control-contracts', 'agent-kernel-pi', 'agent-runtime-aiop', 'agent-runtime-core', 'agent-runtime-mysql', 'pi-runtime',
  'mcp-runtime', 'sandbox-runtime',
  'scheduler-runtime', 'skill-runtime', 'tool-runtime',
];
const snapshotDir = resolve(root, 'docs/public-api');
const update = process.argv.includes('--update');

if (update) await mkdir(snapshotDir, { recursive: true });
const changed: string[] = [];
for (const name of packages) {
  const declaration = await readDeclarations(resolve(root, 'packages', name, 'bin'));
  const snapshot = resolve(snapshotDir, `${name}.d.ts`);
  if (update) {
    await writeFile(snapshot, declaration);
    continue;
  }
  const expected = await readFile(snapshot, 'utf8').catch(() => '');
  if (expected !== declaration) changed.push(name);
}

async function readDeclarations(directory: string): Promise<string> {
  const files = await declarationFiles(directory);
  const sections = await Promise.all(files.map(async (file) => {
    const name = relative(directory, file).split(sep).join('/');
    return `// file: ${name}\n${normalize(await readFile(file, 'utf8'))}`;
  }));
  return `${sections.join('\n').trim()}\n`;
}

async function declarationFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await declarationFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

if (changed.length) {
  throw new Error(`Public API snapshot changed: ${changed.join(', ')}. Review it, then run npm run check:public-api -- --update.`);
}

function normalize(source: string): string {
  return `${source.replace(/^\/\/\# sourceMappingURL=.*$/gm, '').trim()}\n`;
}
