import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const packages = [
  'control-contracts',
  'agent-runtime-core',
  'scheduler-core',
  'agent-kernel-pi',
  'pi-runtime',
  'sandbox-runtime',
  'agent-runtime-mysql',
  'agent-runtime-aiop',
  'mcp-runtime',
  'skill-runtime',
  'tool-runtime',
  'scheduler-mysql',
];

const configPath = resolve(root, 'tsconfig.packages.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
if (loaded.error) fail([loaded.error]);
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
if (parsed.errors.length) fail(parsed.errors);

for (const name of packages) {
  const packageRoot = resolve(root, 'packages', name);
  const outDir = resolve(packageRoot, 'bin');
  await Promise.all([
    rm(resolve(packageRoot, 'dist'), { recursive: true, force: true }),
    rm(outDir, { recursive: true, force: true }),
  ]);
  const program = ts.createProgram({
    rootNames: [resolve(packageRoot, 'src/index.ts')],
    options: { ...parsed.options, noEmit: false, rootDir: resolve(packageRoot, 'src'), outDir },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const result = program.emit();
  if (diagnostics.length || result.emitSkipped) fail([...diagnostics, ...result.diagnostics], name);
}

function fail(diagnostics: readonly ts.Diagnostic[], name?: string): never {
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  };
  const scope = name ? `Package build failed: ${name}\n` : '';
  throw new Error(scope + ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
