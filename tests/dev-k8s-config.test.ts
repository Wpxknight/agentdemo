import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configMaps = [
  'aiop-configmap.yaml',
  'aiop-configmap-oidc.yaml',
  'aiop-configmap-netdiag.yaml',
].map((name) => ({
  name,
  content: readFileSync(new URL(`../deploy/dev-k8s/${name}`, import.meta.url), 'utf8'),
}));

describe('dev K8s model configuration', () => {
  it.each(configMaps)('$name uses the reachable GLM provider instead of the connection-error placeholder', ({ content }) => {
    expect(content).not.toContain('http://127.0.0.1:9/v1');
    expect(content).toContain('"protocol": "anthropic"');
    expect(content).toContain('"baseURL": "http://192.168.10.108:18317"');
    expect(content).toContain('"model": "glm-5"');
    expect(content).toContain('"defaultModel": "glm-5"');
    expect(content).toContain('"apiKey": "${OPENAI_API_KEY}"');
  });
});
