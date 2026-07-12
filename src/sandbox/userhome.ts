/**
 * 用户主目录绑定：校验 / 归一化宿主机路径（HTTP 绑定时与沙箱创建时共用）。
 * 安全边界：只允许绝对路径、拒绝 . / .. 段；配置 sandbox.userHomeRoot 时必须位于其下。
 */

/** 归一化多余斜杠：'/a//b/' → '/a/b'。 */
function normalizePath(p: string): string {
  return `/${p.split('/').filter(Boolean).join('/')}`;
}

/** 绑定主目录时注入系统提示的说明：引导模型默认在挂载目录下工作、把交付物写进持久化目录。 */
export function userHomeSystemNote(mountPath: string): string {
  return [
    `用户主目录：当前用户绑定的宿主机目录已挂载到会话沙箱的 ${mountPath}（环境变量 AIOP_USER_HOME），读写直接持久化到宿主机、沙箱回收后仍保留。`,
    `在沙箱中进行代码开发、文档编写等产出文件的任务时，默认在 ${mountPath} 下工作（可先建子目录再写入），交付物保存到该目录；沙箱其余路径是临时空间，回收即丢失。用户明确指定其他路径时以用户要求为准。`,
  ].join('\n');
}

/**
 * 查询用户绑定并通过校验的主目录，返回对应的系统提示片段；
 * 未绑定 / 校验不过（如管理员事后收紧 root，挂载同样会被拒绝）返回空串。
 */
export async function boundUserHomeNote(
  store: { getUser(tenantId: string, userId: string): Promise<{ homeDir?: string } | undefined> },
  tenantId: string | undefined,
  userId: string | undefined,
  cfg: { root?: string; mountPath: string },
): Promise<string> {
  if (!tenantId || !userId) return '';
  const user = await store.getUser(tenantId, userId).catch(() => undefined);
  if (!user?.homeDir) return '';
  try {
    normalizeUserHomeDir(user.homeDir, cfg.root);
  } catch {
    return '';
  }
  return userHomeSystemNote(cfg.mountPath);
}

/** 校验并归一化用户绑定的主机主目录；不合法时抛出带原因的 Error。 */
export function normalizeUserHomeDir(raw: string, root?: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) throw new Error('主目录必须是宿主机上的绝对路径（以 / 开头）');
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('主目录不能包含 . 或 .. 路径段');
  const normalized = normalizePath(trimmed);
  if (normalized === '/') throw new Error('不允许绑定根目录 /');
  if (root?.trim()) {
    const rootNorm = normalizePath(root);
    if (rootNorm !== '/' && normalized !== rootNorm && !normalized.startsWith(`${rootNorm}/`)) {
      throw new Error(`主目录必须位于 ${rootNorm} 之下`);
    }
  }
  return normalized;
}
