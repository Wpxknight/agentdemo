import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packageDirs = [
  'control-contracts', 'pi-runtime', 'mcp-runtime', 'sandbox-runtime', 'scheduler-runtime',
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
  const project = resolve(temp, 'consumer.mjs');
  const typeConsumer = resolve(temp, 'consumer.ts');
  await writeFile(resolve(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', 'undici-types', ...tarballs], temp);
  const importsSource = `${imports.map((name) => `await import(${JSON.stringify(name)});`).join('\n')}\n`;
  await writeFile(project, importsSource);
  await writeFile(typeConsumer, importsSource);
  run(process.execPath, [project], temp);
  // Consumer declaration check: validate exported package types while ignoring third-party SDK .d.ts internals.
  run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', typeConsumer], temp);
  for (const tarball of tarballs) {
    const data = await readFile(tarball);
    if (!data.length) throw new Error(`Empty package tarball: ${basename(tarball)}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: resolve(temp, 'npm-cache') },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
