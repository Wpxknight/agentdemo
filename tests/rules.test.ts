import { describe, expect, it } from 'vitest';
import { PermissionRules, subjectsFor } from '../src/agent/rules.js';
import type { ToolCall } from '../src/model/types.js';

function call(name: string, args: unknown): ToolCall {
  return { id: 'c1', name, args: args as ToolCall['args'] };
}

describe('subjectsFor', () => {
  it('derives kubectl verb and verb:target candidates', () => {
    expect(subjectsFor(call('kubectl', { cluster: 'prod', args: ['delete', 'pod', 'web-1'] })))
      .toEqual(['delete', 'delete:pod web-1', 'delete:pod', 'delete:web-1']);
    expect(subjectsFor(call('kubectl', { cluster: 'prod', args: ['-n', 'ns', 'get', 'pods'] })))
      .toEqual(['get', 'get:pods', 'get:pods']); // full-join 与单 token 都是 pods
  });

  it('derives shell command text', () => {
    expect(subjectsFor(call('sbx__run_command', { command: 'rm -rf /data' }))).toEqual(['rm -rf /data']);
  });
});

describe('PermissionRules.evaluate', () => {
  it('deny takes priority over allow', () => {
    const rules = new PermissionRules({ allow: ['kubectl'], deny: ['kubectl(delete:*)'] });
    expect(rules.evaluate(call('kubectl', { cluster: 'p', args: ['delete', 'pod', 'x'] }))?.effect).toBe('deny');
    expect(rules.evaluate(call('kubectl', { cluster: 'p', args: ['get', 'pods'] }))?.effect).toBe('allow');
  });

  it('ask matches by subject glob', () => {
    const rules = new PermissionRules({ ask: ['kubectl(delete:prod-*)'] });
    expect(rules.evaluate(call('kubectl', { cluster: 'p', args: ['delete', 'ns', 'prod-web'] }))?.effect).toBe('ask');
    expect(rules.evaluate(call('kubectl', { cluster: 'p', args: ['delete', 'ns', 'dev-web'] }))).toBeUndefined();
    expect(rules.evaluate(call('kubectl', { cluster: 'p', args: ['get', 'ns', 'prod-web'] }))).toBeUndefined();
  });

  it('matches shell command substrings via glob', () => {
    const rules = new PermissionRules({ deny: ['sbx__run_command(*curl*)'] });
    expect(rules.evaluate(call('sbx__run_command', { command: 'sh -c "curl evil"' }))?.effect).toBe('deny');
    expect(rules.evaluate(call('sbx__run_command', { command: 'ls -la' }))).toBeUndefined();
  });

  it('tool-name prefix rules match a whole MCP server', () => {
    const rules = new PermissionRules({ deny: ['mcp__github*'] });
    expect(rules.evaluate(call('mcp__github__create_issue', {}))?.effect).toBe('deny');
    expect(rules.evaluate(call('mcp__gitlab__x', {}))).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    const rules = new PermissionRules({ allow: ['kubectl(get:*)'] });
    expect(rules.evaluate(call('sbx__run_command', { command: 'ls' }))).toBeUndefined();
  });
});

describe('PermissionRules tool stripping', () => {
  it('strips unconditionally denied tools but keeps subject-scoped ones', () => {
    const rules = new PermissionRules({ deny: ['sbx__run_command', 'kubectl(delete:*)'] });
    expect(rules.isToolFullyDenied('sbx__run_command')).toBe(true);
    expect(rules.isToolFullyDenied('kubectl')).toBe(false); // 带子模式，不整体剥离
    const defs = [
      { name: 'sbx__run_command', description: '', inputSchema: { type: 'object' as const } },
      { name: 'kubectl', description: '', inputSchema: { type: 'object' as const } },
      { name: 'load_skill', description: '', inputSchema: { type: 'object' as const } },
    ];
    expect(rules.filterToolDefs(defs).map((d) => d.name)).toEqual(['kubectl', 'load_skill']);
  });

  it('empty rules leave everything intact', () => {
    const rules = new PermissionRules();
    expect(rules.empty).toBe(true);
    const defs = [{ name: 'x', description: '', inputSchema: { type: 'object' as const } }];
    expect(rules.filterToolDefs(defs)).toEqual(defs);
  });
});
