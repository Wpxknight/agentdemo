import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packageDirs = [
  'control-contracts', 'agent-kernel-pi', 'agent-runtime-aiop', 'agent-runtime-core', 'agent-runtime-mysql',
  'mcp-runtime', 'sandbox-core', 'sandbox-e2b', 'sandbox-local', 'sandbox-opensandbox',
  'scheduler-core', 'scheduler-mysql', 'skill-runtime', 'tool-runtime',
];
const temp = await mkdtemp(join(tmpdir(), 'aiop-package-verify-'));
try {
  const tarballs: string[] = [];
  const imports: string[] = [];
  for (const name of packageDirs) {
    run('npm', ['pack', '--json', '--dry-run', resolve(root, 'packages', name)], root);
    const packed = run('npm', ['pack', '--json', '--pack-destination', temp, resolve(root, 'packages', name)], root);
    const info = JSON.parse(packed) as Array<{ filename: string; files: Array<{ path: string }> }>;
    if (info[0]!.files.some((file) => file.path.startsWith('src/'))) throw new Error(`${name} tarball contains TypeScript source`);
    tarballs.push(resolve(temp, info[0]!.filename));
    imports.push(String(JSON.parse(await readFile(resolve(root, 'packages', name, 'package.json'), 'utf8')).name));
  }
  const project = resolve(temp, 'consumer');
  await writeFile(resolve(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], temp);
  await writeFile(project, `${imports.map((name) => `await import(${JSON.stringify(name)});`).join('\n')}\n`);
  run(process.execPath, [project], temp);
  for (const tarball of tarballs) {
    const data = await readFile(tarball);
    if (!data.length) throw new Error(`Empty package tarball: ${basename(tarball)}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
