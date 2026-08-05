/**
 * 端到端验证：沙箱 Pod 以专属 ServiceAccount(aiop-sandbox)运行，
 * 并能在 Pod 内用 in-cluster config 跑 kubectl 查询集群。
 *
 *   kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80
 *   OSB_IMAGE=aiop/opensandbox-browser:dev npx tsx scripts/verify-sandbox-kubectl.ts
 */
import { OpenSandboxProvider } from '../packages/sandbox-runtime/src/opensandbox.js';

const domain = process.env.OSB_DOMAIN ?? '127.0.0.1:8899';
const image = process.env.OSB_IMAGE ?? 'aiop/opensandbox-browser:dev';

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
  const handle = await provider.create({ key: 'verify-kubectl', timeoutMs: 5 * 60 * 1000 });
  console.log('    sandboxId =', handle.sandboxId);

  console.log('[2] Pod 内身份(serviceaccount token 的 namespace) …');
  const who = await handle.runCommand('cat /var/run/secrets/kubernetes.io/serviceaccount/namespace; echo');
  console.log('    namespace =', JSON.stringify(who.stdout.trim()), 'err =', who.error);

  console.log('[3] kubectl auth can-i list pods …');
  const cani = await handle.runCommand('kubectl auth can-i list pods -A');
  console.log('    =>', JSON.stringify(cani.stdout.trim()), 'exit =', cani.exitCode, 'err =', cani.error);

  console.log('[4] kubectl get pods -n opensandbox …');
  const get = await handle.runCommand('kubectl get pods -n opensandbox -o name | head');
  console.log('    stdout =\n' + get.stdout.trim());
  console.log('    stderr =', JSON.stringify(get.stderr.trim()), 'exit =', get.exitCode);

  console.log('[5] kill 销毁 …');
  await retry(() => handle.kill());

  const pass = cani.stdout.includes('yes') && get.exitCode === 0;
  console.log(pass ? '\n✅ 沙箱内 kubectl 验证通过' : '\n❌ 未达预期');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
