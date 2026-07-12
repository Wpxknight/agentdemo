import { describe, expect, it } from 'vitest';
import { boundUserHomeNote, normalizeUserHomeDir } from '../src/sandbox/userhome.js';

describe('normalizeUserHomeDir', () => {
  it('接受绝对路径并归一化多余斜杠', () => {
    expect(normalizeUserHomeDir('/data/homes/alice')).toBe('/data/homes/alice');
    expect(normalizeUserHomeDir('  /data//homes/alice/ ')).toBe('/data/homes/alice');
  });

  it('拒绝相对路径、. / .. 段和根目录', () => {
    expect(() => normalizeUserHomeDir('data/homes')).toThrow('绝对路径');
    expect(() => normalizeUserHomeDir('/data/../etc')).toThrow('..');
    expect(() => normalizeUserHomeDir('/data/./x')).toThrow();
    expect(() => normalizeUserHomeDir('/')).toThrow('根目录');
  });

  it('配置 root 时强制前缀边界（含同名目录前缀绕过）', () => {
    expect(normalizeUserHomeDir('/data/homes/alice', '/data/homes')).toBe('/data/homes/alice');
    expect(normalizeUserHomeDir('/data/homes', '/data/homes/')).toBe('/data/homes');
    expect(() => normalizeUserHomeDir('/etc', '/data/homes')).toThrow('/data/homes');
    // '/data/homes-evil' 以字符串前缀看似匹配 '/data/homes'，必须拒绝。
    expect(() => normalizeUserHomeDir('/data/homes-evil', '/data/homes')).toThrow();
  });

  it('root 为空白时不限制前缀', () => {
    expect(normalizeUserHomeDir('/opt/x', '  ')).toBe('/opt/x');
    expect(normalizeUserHomeDir('/opt/x', undefined)).toBe('/opt/x');
  });
});

describe('boundUserHomeNote', () => {
  const cfg = { mountPath: '/home/user/host' };
  const storeWith = (homeDir?: string) => ({
    async getUser() { return { homeDir }; },
  });

  it('绑定有效主目录时返回含挂载点的提示', async () => {
    const note = await boundUserHomeNote(storeWith('/data/homes/alice'), 't1', 'u1', cfg);
    expect(note).toContain('/home/user/host');
    expect(note).toContain('AIOP_USER_HOME');
  });

  it('未绑定 / 身份缺失 / 校验不过时返回空串', async () => {
    expect(await boundUserHomeNote(storeWith(undefined), 't1', 'u1', cfg)).toBe('');
    expect(await boundUserHomeNote(storeWith('/data/x'), undefined, 'u1', cfg)).toBe('');
    // 管理员收紧 root 后存量绑定越界：不挂载也不提示
    expect(await boundUserHomeNote(storeWith('/etc'), 't1', 'u1', { ...cfg, root: '/data/homes' })).toBe('');
  });

  it('store 查询异常时返回空串（不阻断运行）', async () => {
    const broken = { async getUser(): Promise<{ homeDir?: string }> { throw new Error('db down'); } };
    expect(await boundUserHomeNote(broken, 't1', 'u1', cfg)).toBe('');
  });
});
