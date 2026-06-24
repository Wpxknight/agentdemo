/**
 * 演示：沙箱执行过程的实时流式输出（onOutput 逐段到达，而非执行完一次性返回）。
 *
 *   kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80
 *   OSB_IMAGE=aiop/opensandbox-browser:dev npx tsx scripts/demo-sandbox-stream.ts
 *
 * 期望：每段输出的相对时间戳 ≈ 1000ms 递增；若是缓冲，全部会在 ~5000ms 同时到达。
 */
import { OpenSandboxProvider } from '../src/sandbox/opensandbox.js';

const domain = process.env.OSB_DOMAIN ?? '127.0.0.1:8899';
const image = process.env.OSB_IMAGE ?? 'aiop/opensandbox-browser:dev';

async function main() {
  const p = new OpenSandboxProvider({ domain, protocol: 'http', defaultImage: image });
  const h = await p.create({ key: 'stream-demo', timeoutMs: 5 * 60 * 1000 });
  console.log('sandboxId =', h.sandboxId, '\n运行: 每秒输出一行，共 5 行\n');

  const t0 = Date.now();
  const res = await h.runCommand(
    'for i in 1 2 3 4 5; do echo "进度 $i/5"; sleep 1; done',
    { onOutput: (c) => console.log(`  实时到达 +${String(Date.now() - t0).padStart(4)}ms  [${c.stream}] ${c.text.trimEnd()}`) },
  );

  console.log('\n执行结束，最终聚合 stdout（与上面实时片段一致）:\n' + res.stdout.trimEnd());
  await h.kill().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('demo 失败:', e); process.exit(1); });
