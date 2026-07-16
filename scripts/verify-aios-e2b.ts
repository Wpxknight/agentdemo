import { loadConfig } from '../src/config/load.js';
import { buildRuntime } from '../src/runtime.js';

const SMOKE_KEY = `aios-e2b-smoke:${process.pid}`;
const FILE_PATH = '/workspace/aiop-aios-smoke.txt';
const FILE_CONTENT = 'aiop-aios-main-flow-ok';

async function main(): Promise<void> {
  const runtime = await buildRuntime(loadConfig());
  const manager = runtime.sandboxes;
  if (!manager) {
    await runtime.dispose();
    throw new Error('AIOS Sandbox must be enabled and saved through Settings before running this smoke test');
  }

  try {
    const sandbox = await manager.get({
      key: SMOKE_KEY,
      profile: 'code',
      template: 'code-interpreter',
      timeoutMs: 5 * 60_000,
      metadata: { sessionId: SMOKE_KEY, profile: 'code', purpose: 'aios-e2b-smoke' },
      envs: { AIOP_SANDBOX_PROFILE: 'code' },
    });
    console.log(`[create] ready sandbox=${sandbox.sandboxId}`);

    const command = await sandbox.runCommand('printf aiop-command-ok');
    if (command.exitCode !== 0 || command.stdout !== 'aiop-command-ok') {
      throw new Error(`runCommand verification failed (exit=${command.exitCode ?? 'unknown'})`);
    }
    console.log('[runCommand] ok');

    const code = await sandbox.runCode('print(6 * 7)', { language: 'python' });
    if (code.exitCode !== 0 || code.stdout.trim() !== '42') {
      throw new Error(`runCode verification failed (exit=${code.exitCode ?? 'unknown'})`);
    }
    console.log('[runCode] ok');

    const encoded = Buffer.from(FILE_CONTENT, 'utf8').toString('base64');
    const write = await sandbox.runCommand(`mkdir -p /workspace && printf '%s' '${encoded}' | base64 -d > '${FILE_PATH}'`);
    if (write.exitCode !== 0) throw new Error(`file write command failed (exit=${write.exitCode ?? 'unknown'})`);
    const file = await sandbox.readFile(FILE_PATH);
    if (Buffer.from(file).toString('utf8') !== FILE_CONTENT) throw new Error('readFile content mismatch');
    console.log('[readFile] ok');

    await sandbox.setTimeout(5 * 60_000);
    console.log('[setTimeout] ok');
  } finally {
    await manager.dispose(SMOKE_KEY).catch((error) => {
      console.error(`[kill] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await runtime.dispose();
  }

  console.log('[kill] ok');
  console.log('AIOS E2B main-flow smoke passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
