/**
 * 端到端验证：用 aiop 的 OpenSandboxProvider 连接 k8s 内的 OpenSandbox，
 * 真正创建一个沙箱、执行命令与代码、再销毁。
 *
 *   kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80
 *   npx tsx scripts/verify-opensandbox.ts
 */
import { OpenSandboxProvider } from '../packages/sandbox-runtime/src/opensandbox.js';

const domain = process.env.OSB_DOMAIN ?? '127.0.0.1:8899';
const image = process.env.OSB_IMAGE ?? 'ubuntu';

/** kubectl port-forward 会关闭空闲 keepalive 连接，对生命周期调用做一次重试。 */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

async function main() {
  const provider = new OpenSandboxProvider({ domain, protocol: 'http', defaultImage: image });
  console.log(`[1] 创建沙箱 (domain=${domain}, image=${image}) …`);
  const handle = await provider.create({ key: 'verify-1', timeoutMs: 5 * 60 * 1000 });
  console.log('    sandboxId =', handle.sandboxId);

  console.log('[2] setTimeout 续期 …');
  await retry(() => handle.setTimeout(10 * 60 * 1000));
  console.log('    ok');

  console.log('[3] runCommand: echo + uname …');
  const r1 = await handle.runCommand('echo hello-from-opensandbox && uname -s');
  console.log('    stdout =', JSON.stringify(r1.stdout), 'exit =', r1.exitCode, 'err =', r1.error);

  console.log('[4] runCode (bash): 算术 …');
  const r2 = await handle.runCode('x=$((6*7)); echo "bash: $x"', { language: 'bash' });
  console.log('    stdout =', JSON.stringify(r2.stdout), 'err =', r2.error);

  console.log('[5] kill 销毁 …');
  await retry(() => handle.kill());
  console.log('    ok');

  const pass = r1.stdout.includes('hello-from-opensandbox') && r2.stdout.includes('bash: 42');
  console.log(pass ? '\n✅ 验证通过' : '\n❌ 输出不符合预期');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
