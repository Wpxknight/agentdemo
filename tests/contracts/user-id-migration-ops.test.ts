import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL('../../scripts/migrate-user-id-staging.sh', import.meta.url);
const rollbackScriptUrl = new URL('../../scripts/rollback-aiop-compatible.sh', import.meta.url);
const makefileUrl = new URL('../../Makefile', import.meta.url);

function position(source: string, marker: string): number {
  const value = source.indexOf(`migration-step:${marker}`);
  expect(value, `missing migration marker ${marker}`).toBeGreaterThan(-1);
  return value;
}

describe('staging user-id migration operational contract', () => {
  it('keeps the AIOS identity preflight explicit instead of blocking test-environment deployment', async () => {
    const makefile = await readFile(makefileUrl, 'utf8');
    const deployTarget = makefile.slice(
      makefile.indexOf('deploy-aios-integrated:'),
      makefile.indexOf('\ncheck-user-id-migration:'),
    );
    expect(deployTarget).not.toContain('$(MAKE) check-user-id-migration');
    expect(deployTarget).toContain('AIOP_ALLOW_MIXED_IDENTITY_SOURCE=$(AIOP_ALLOW_MIXED_IDENTITY_SOURCE)');
    expect(deployTarget).toContain('AIOP_DEPLOY_IMAGE=$(PUBLISH_IMAGE) AIOP_DEPLOY_WEB_IMAGE=$(PUBLISH_WEB_IMAGE)');
    expect(makefile).toContain('AIOP_ALLOW_MIXED_IDENTITY_SOURCE ?= false');
    expect(makefile).toContain('AIOP_AIOS_DEBUG_LOCAL_LOGIN ?= false');
    expect(makefile).not.toContain('AIOP_AIOS_SANDBOX_CLUSTER_DIRECTORY');
    expect(deployTarget).toContain('AIOP_AIOS_DEBUG_LOCAL_LOGIN=$(AIOP_AIOS_DEBUG_LOCAL_LOGIN)');
    expect(makefile).toContain('DEBUG_LOCAL_PASSWORD_SECRET ?= aiop-debug-local-login');
    expect(makefile).toContain("get secret \"$(DEBUG_LOCAL_PASSWORD_SECRET)\" -o jsonpath='{.data.password}'");
    expect(makefile).toContain('\ncheck-user-id-migration:');
    expect(makefile).toContain('scripts/check-user-id-migration.ts');
  });

  it('orders backup, both preflights, quiescence, migration, postcheck and restore', async () => {
    const source = await readFile(scriptUrl, 'utf8');
    const order = ['backup', 'precheck', 'scale0', 'quiesced-check', 'migrate', 'postcheck'];
    const positions = order.map((marker) => position(source, marker));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(position(source, 'restore')).toBeLessThan(position(source, 'backup'));
    expect(source.match(/preflight/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('get pods -l "$selector" -o name');
  });

  it('arms restoration before scale so a non-zero scale result still restores original replicas', async () => {
    const source = await readFile(scriptUrl, 'utf8');
    expect(source).toContain('trap restore EXIT');
    expect(source).toContain("trap 'exit 130' INT");
    expect(source).toContain("trap 'exit 143' TERM");
    expect(source).toContain('local status=$?');
    expect(source).toContain('current_replicas="$(kube get');
    expect(source).toContain('--replicas="$original_replicas"');
    expect(source).toContain('ERROR: failed to restore Deployment');
    expect(source).toContain('exit "$status"');

    const arm = source.indexOf('restoration_required=1');
    const scale = source.indexOf('kube scale "deployment/$MIGRATION_DEPLOYMENT" --replicas=0');
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(scale);
  });

  it('binds context and deployment annotations before scale and requires exact target confirmation', async () => {
    const source = await readFile(scriptUrl, 'utf8');
    for (const variable of [
      'MIGRATION_NAMESPACE',
      'MIGRATION_DEPLOYMENT',
      'MIGRATION_EXPECTED_REPLICAS',
      'AIOP_EXPECTED_KUBE_CONTEXT',
    ]) {
      expect(source).toContain(`\${${variable}:?`);
    }
    expect(source).toContain('config current-context');
    expect(source).toContain(
      'kube() { "${kubectl_cmd[@]}" --context "$AIOP_EXPECTED_KUBE_CONTEXT" -n "$MIGRATION_NAMESPACE" "$@"; }',
    );
    const kubectlCalls = [...source.matchAll(/"\$\{kubectl_cmd\[@\]\}"([^\n]*)/g)].map((match) => match[1]);
    expect(kubectlCalls).toHaveLength(2);
    expect(kubectlCalls[0]).toContain('--context "$AIOP_EXPECTED_KUBE_CONTEXT"');
    expect(kubectlCalls[1]).toBe(' config current-context)"');
    expect(source).toContain('aiop\\.bocloud\\.com/environment');
    expect(source).toContain('aiop\\.bocloud\\.com/database');
    expect(source).toContain('context=$AIOP_EXPECTED_KUBE_CONTEXT namespace=$MIGRATION_NAMESPACE deployment=$MIGRATION_DEPLOYMENT database=$MYSQL_DATABASE');
    expect(source).toContain('[[ "$CONFIRM_USER_ID_MIGRATION" != "$expected_confirmation" ]]');

    const scale = position(source, 'scale0');
    expect(source.indexOf('Kubernetes context mismatch')).toBeLessThan(scale);
    expect(source.indexOf('Deployment environment annotation mismatch')).toBeLessThan(scale);
    expect(source.indexOf('Deployment database annotation mismatch')).toBeLessThan(scale);
    expect(source).toContain('Deployment replicas mismatch');
  });
});

describe('AIoP rollback compatibility contract', () => {
  it('dry-runs the target revision and rejects schema or ConfigMap mode mismatches', async () => {
    const source = await readFile(rollbackScriptUrl, 'utf8');
    expect(source).toContain('rollout undo deployment/aiop-server');
    expect(source.match(/--dry-run=server/g)).toHaveLength(2);
    expect(source).toContain('schema-compatibility');
    expect(source).toContain('positive-user-ids-v1');
    expect(source).toContain('configmap/aiop-config');
    expect(source).toContain('target_mode" != "$config_mode');
    expect(source.indexOf('target_schema=')).toBeLessThan(source.lastIndexOf('kube rollout undo deployment/aiop-server'));
  });

  it('marks both deployment modes with the same schema compatibility and explicit mode', async () => {
    const standalone = await readFile(new URL('../../deploy/aiop/deployment.yaml', import.meta.url), 'utf8');
    const integrated = await readFile(new URL('../../deploy/aiop/deployment-aios-integrated.yaml', import.meta.url), 'utf8');
    for (const manifest of [standalone, integrated]) {
      expect(manifest).toContain('aiop.bocloud.com/schema-compatibility: positive-user-ids-v1');
    }
    expect(standalone).toContain('aiop.bocloud.com/deployment-mode: standalone');
    expect(integrated).toContain('aiop.bocloud.com/deployment-mode: aios-integrated');
  });

  it('keeps the AIOS integrated UI sidecar and external test entrypoint in the deployment contract', async () => {
    const makefile = await readFile(makefileUrl, 'utf8');
    const deployment = await readFile(new URL('../../deploy/aiop/deployment-aios-integrated.yaml', import.meta.url), 'utf8');
    const service = await readFile(new URL('../../deploy/aiop/service-aios-integrated.yaml', import.meta.url), 'utf8');
    expect(deployment).toMatch(/name:\s+aiop-web/);
    expect(deployment).toContain('deploy.bocloud.k8s:40443/aios/aiop-web:dev');
    expect(deployment).toContain('containerPort: 8080');
    expect(service).toMatch(/type:\s+NodePort/);
    expect(service).toMatch(/targetPort:\s+8080/);
    expect(service).toMatch(/nodePort:\s+30084/);
    expect(makefile).toContain('aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE)');
    const deployTarget = makefile.slice(
      makefile.indexOf('deploy-aios-integrated:'),
      makefile.indexOf('\ncheck-user-id-migration:'),
    );
    const deleteService = deployTarget.indexOf('delete -f deploy/aiop/service-aios-integrated.yaml');
    const applyService = deployTarget.indexOf('apply -f deploy/aiop/service-aios-integrated.yaml');
    expect(deleteService).toBeGreaterThan(-1);
    expect(deleteService).toBeLessThan(applyService);
  });
});
