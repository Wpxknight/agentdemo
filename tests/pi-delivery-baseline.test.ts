import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('Pi delivery baseline', () => {
  it('builds workspace package declarations before every formal test entry point', async () => {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.pretest).toBe('npm run build:packages');
    expect(manifest.scripts['test:agent-platform']).toMatch(/^npm run build:packages && vitest run/);
    expect(manifest.scripts['test:runtime-refactor']).toMatch(/^npm run build:packages && npm run typecheck/);
  });

  it('runs the Node, package, full test, web, audit, and image gates in GitLab CI', async () => {
    const source = await readFile(new URL('.gitlab-ci.yml', root), 'utf8');

    expect(source).toContain('node:24-slim');
    expect(source).toContain('apt-get install -y --no-install-recommends make');
    expect(source).toContain('apk add --no-cache make');
    for (const command of [
      'make verify-node',
      'make test-agent-platform',
      'npm run typecheck',
      'npm test',
      'npm --prefix web ci',
      'npm --prefix web run build',
      'npm audit --audit-level=high',
      'make image',
    ]) expect(source).toContain(command);
    expect(source).toContain('docker:27-dind');
  });

  it('deploys new development runs in Pi full mode without kernel selection', async () => {
    const source = await readFile(new URL('deploy/dev-k8s/aiop-deployment.yaml', root), 'utf8');

    expect(source).not.toContain('name: AIOP_AGENT_KERNEL');
    expect(source).toContain('name: AIOP_PI_MODE');
    expect(source).toMatch(/name: AIOP_PI_MODE\s+value: full/);
  });

  it('builds public package bin output inside the image instead of copying host artifacts', async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile(new URL('Dockerfile', root), 'utf8'),
      readFile(new URL('.dockerignore', root), 'utf8'),
    ]);

    expect(dockerfile).toContain('COPY tsconfig.packages.json ./');
    expect(dockerfile).toContain('COPY scripts/build-packages.ts ./scripts/build-packages.ts');
    expect(dockerfile).toContain('RUN npm run build:packages');
    expect(dockerfile).toContain('COPY --from=deps /app/packages ./packages');
    expect(dockerignore).toContain('packages/*/bin');
  });
});
