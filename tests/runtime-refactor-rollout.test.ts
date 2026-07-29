import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('runtime refactor staging rollout source boundary', () => {
  it('builds immutable backend and web images from the current commit', async () => {
    const makefile = await readFile(new URL('Makefile', root), 'utf8');

    expect(makefile).toContain('IMAGE_TAG ?= $(shell git rev-parse --short HEAD)');
    expect(makefile).toContain('IMAGE ?= aiop:$(IMAGE_TAG)');
    expect(makefile).toContain('WEB_IMAGE ?= aiop-web:$(IMAGE_TAG)');
    expect(makefile).toContain('docker build -t $(IMAGE) .');
    expect(makefile).toContain('docker build -f web/Dockerfile -t $(WEB_IMAGE) .');
    expect(makefile).toContain("import('@aiop/pi-runtime').then(() => console.log('workspace-ok'))");
    expect(makefile).toContain('docker run --rm $(IMAGE) npm run verify:node');
  });

  it('deploys only the dev stack after checking the pre-provisioned secret', async () => {
    const makefile = await readFile(new URL('Makefile', root), 'utf8');

    expect(makefile).toContain('$(KUBECTL) apply -f deploy/dev-k8s/namespace.yaml');
    expect(makefile).toContain(
      '$(KUBECTL) -n aiop-dev get secret aiop-dev-secrets -o name >/dev/null',
    );
    expect(makefile).not.toContain('apply -f deploy/dev-k8s/aiop-secret.example.yaml');
    expect(makefile).not.toContain('apply -f deploy/k8s/');
    expect(makefile).not.toMatch(/(?:^|\s)-n aiop(?:\s|$)/m);
    expect(makefile).not.toContain('ReadWriteMany');
    expect(makefile).not.toContain('RWX');

    for (const manifest of [
      'mysql.yaml',
      'oidc-test.yaml',
      'aiop-configmap.yaml',
      'aiop-service-nodeport.yaml',
      'ops-rbac.yaml',
    ]) expect(makefile).toContain(`$(KUBECTL) apply -f deploy/dev-k8s/${manifest}`);

    expect(makefile).toContain(
      '$(KUBECTL) set image -f deploy/dev-k8s/aiop-deployment.yaml aiop=$(IMAGE) aiop-web=$(WEB_IMAGE) --local -o yaml | $(KUBECTL) apply -f -',
    );
    for (const deployment of ['mysql', 'dex', 'aiop-server']) {
      expect(makefile).toContain(
        `$(KUBECTL) -n aiop-dev rollout status deployment/${deployment} --timeout=180s`,
      );
    }
  });

  it('uses the injected MySQL root password for readiness without exposing it in arguments', async () => {
    const manifest = await readFile(new URL('deploy/dev-k8s/mysql.yaml', root), 'utf8');

    expect(manifest).toContain('name: MYSQL_ROOT_PASSWORD');
    expect(manifest).toContain(
      'command: ["sh", "-c", "MYSQL_PWD=\\\"$MYSQL_ROOT_PASSWORD\\\" exec mysqladmin ping -h 127.0.0.1 -uroot --silent"]',
    );
    expect(manifest).not.toContain('aiop-root-pass');
    expect(manifest).not.toMatch(/mysqladmin[^\n]*-p[^$\s"']/);
  });

  it('rolls back the aiop-dev server deployment and waits for readiness', async () => {
    const makefile = await readFile(new URL('Makefile', root), 'utf8');

    expect(makefile).toContain('$(KUBECTL) -n aiop-dev rollout undo deployment/aiop-server');
    expect(makefile).toContain(
      '$(KUBECTL) -n aiop-dev rollout status deployment/aiop-server --timeout=180s',
    );
    expect(makefile).not.toContain('$(KUBECTL) -n aiop rollout undo');
  });
});

describe('runtime refactor documentation source boundary', () => {
  it('documents the five current packages without retired source paths', async () => {
    const paths = [
      'docs/design/01-system-overview.md',
      'docs/design/02-agent-runtime.md',
      'docs/design/03-model-and-context.md',
      'docs/design/04-tools-skills-mcp.md',
      'docs/design/05-sandbox-and-ops.md',
      'docs/design/07-data-and-persistence.md',
      'docs/design/08-scheduler.md',
      'docs/design/09-api-and-web.md',
      'docs/design/10-deployment-observability.md',
      'docs/design/README.md',
      'docs/guide/code-walkthrough.md',
      'docs/pi-agent-platform-operations.md',
    ];
    const source = (await Promise.all(
      paths.map((path) => readFile(new URL(path, root), 'utf8')),
    )).join('\n');

    for (const packageName of [
      'packages/control-contracts',
      'packages/pi-runtime',
      'packages/mcp-runtime',
      'packages/sandbox-runtime',
      'packages/scheduler-runtime',
    ]) expect(source).toContain(packageName);

    for (const retiredPath of [
      'packages/agent-contracts',
      'packages/agent-kernel-pi',
      'packages/agent-runtime-core',
      'packages/agent-runtime-mysql',
      'packages/agent-runtime-aiop',
      'packages/tool-runtime',
      'packages/skill-runtime',
      'src/agent/pi',
    ]) expect(source).not.toContain(retiredPath);
    for (const retiredSource of ['src/model/', 'src/mcp/', 'src/sandbox/']) {
      expect(source).not.toMatch(new RegExp(`(?<!/)${retiredSource}`));
    }
  });

  it('keeps current HTTP and deployment docs aligned with Pi-only runtime behavior', async () => {
    const [api, deployment, operations] = await Promise.all([
      readFile(new URL('docs/design/09-api-and-web.md', root), 'utf8'),
      readFile(new URL('docs/design/10-deployment-observability.md', root), 'utf8'),
      readFile(new URL('docs/pi-agent-platform-operations.md', root), 'utf8'),
    ]);

    expect(api).toContain('SSE 客户端断开只会 detach 响应');
    expect(api).not.toContain('客户端断开、终止接口或 Agent Run 取消会触发 AbortSignal');
    expect(deployment).toContain('deploy/dev-k8s/');
    expect(deployment).toContain('namespace `aiop-dev`');
    expect(deployment).toContain('make deploy-staging');
    expect(deployment).toContain('make rollback-staging');
    for (const retiredConcept of ['LangGraph', 'Checkpoint', '图版本', 'Kernel 灰度']) {
      expect(deployment).not.toContain(retiredConcept);
    }
    expect(operations).toContain('--no-tablespaces');
  });
});
