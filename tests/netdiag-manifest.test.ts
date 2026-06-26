import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifestPath = resolve('deploy/opensandbox/netdiag-sandbox.yaml');
const manifest = readFileSync(manifestPath, 'utf8');
const devConfigPath = resolve('deploy/dev-k8s/aiop-configmap-netdiag.yaml');
const skillPath = resolve('skills/netdiag/SKILL.md');
const skill = readFileSync(skillPath, 'utf8');
const serverDockerfilePath = resolve('deploy/opensandbox/Dockerfile.server-netdiag');
const serverPatchPath = resolve('deploy/opensandbox/patches/merge-netdiag-security-context.py');

describe('netdiag sandbox manifest', () => {
  it('runs OpenSandbox workloads as the dedicated netdiag ServiceAccount with host privileges', () => {
    expect(manifest).toContain('name: aiop-netdiag');
    expect(manifest).toContain('serviceAccountName: aiop-netdiag');
    expect(manifest).toContain('hostNetwork: true');
    expect(manifest).toContain('hostPID: true');
    expect(manifest).toContain('privileged: true');
    expect(manifest).toContain('name: opensandbox');
    expect(manifest).toContain('pod-security.kubernetes.io/enforce: privileged');
    expect(manifest).toContain('imagePullPolicy: IfNotPresent');
    expect(manifest).toContain('path: /opt/cni/bin');
    expect(manifest).toContain('path: /etc/cni/net.d');
    expect(manifest).toContain('mountPath: /etc/cni/net.d');
  });

  it('allows netdiag to inspect and repair RBAC during operations', () => {
    expect(manifest).toContain('resources: ["pods/exec", "pods/attach", "pods/portforward"]');
    expect(manifest).toContain('resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"]');
    expect(manifest).toContain('resources: ["roles", "rolebindings"]');
    expect(manifest).toContain('resources: ["clusterroles", "clusterrolebindings"]');
    expect(manifest).toContain('verbs: ["get", "list", "watch", "create", "update", "patch"]');
  });

  it('allows the netdiag sandbox service account to create runtime workloads and services', () => {
    expect(manifest).toContain('resources: ["pods", "services", "configmaps"]');
    expect(manifest).toContain('resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]');
    expect(manifest).toContain('resources: ["jobs", "cronjobs"]');
    expect(manifest).toContain('resources: ["pods/exec", "pods/attach", "pods/portforward"]');
    expect(manifest).toContain('verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]');
  });

  it('allows netdiag to create namespaces', () => {
    expect(manifest).toContain('resources: ["namespaces"]');
  });

  it('grants fabric-node durable e2e DaemonSet permission fabric-admin requires', () => {
    expect(manifest).toContain('name: fabric-e2e');
    expect(manifest).toContain('name: fabric-node-e2e');
    expect(manifest).toContain('kind: ClusterRole');
    expect(manifest).toContain('kind: ClusterRoleBinding');
    expect(manifest).toContain('resources: ["daemonsets"]');
    expect(manifest).toContain('name: fabric-node-serviceaccount');
    expect(manifest).toContain('namespace: kube-system');
    expect(manifest).toContain('e2e 流程会清理并重建 fabric-e2e namespace');
  });

  it('provides an aiop dev config that uses the netdiag runtime image', () => {
    expect(existsSync(devConfigPath)).toBe(true);
    const config = readFileSync(devConfigPath, 'utf8');
    expect(config).toContain('name: aiop-config-netdiag');
    expect(config).toContain('"defaultImage": "aiop/opensandbox-netdiag:dev"');
    expect(config).toContain('"desktop": false');
  });

  it('documents fabric-admin as the preferred network operations entrypoint', () => {
    expect(skill).toContain('优先使用 `/opt/cni/bin/fabric-admin` 命令行');
    expect(skill).toContain('/opt/cni/bin/fabric-admin health show');
    expect(skill).toContain('/opt/cni/bin/fabric-admin e2e network');
  });

  it('patches OpenSandbox server to preserve privileged securityContext from the template', () => {
    expect(existsSync(serverDockerfilePath)).toBe(true);
    expect(existsSync(serverPatchPath)).toBe(true);
    const dockerfile = readFileSync(serverDockerfilePath, 'utf8');
    const patch = readFileSync(serverPatchPath, 'utf8');
    expect(dockerfile).toContain('merge-netdiag-security-context.py');
    expect(patch).toContain('securityContext');
    expect(patch).toContain('imagePullPolicy');
    expect(patch).toContain('_merge_pod_spec_extras');
  });
});
