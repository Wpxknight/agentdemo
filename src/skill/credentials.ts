import { posix } from 'node:path';
import { logger } from '../logger.js';
import type { ToolContext } from '../agent/tools.js';
import type { UserCredentials } from '../auth/credentials.js';
import type { AuditSink } from '../audit/sink.js';
import type { SandboxHandle } from '@aiop/sandbox-runtime';
import type { Skill } from './product.js';
import { normalizeCredentialFile } from './product.js';

const log = logger.child({ mod: 'skill-credentials' });

export interface SkillCredentialDeps {
  credentials?: UserCredentials;
  audit?: AuditSink;
}

export async function injectSkillCredentials(opts: {
  skill: Skill;
  sbx: SandboxHandle;
  dest: string;
  ctx: ToolContext;
  markCredentialInjected: () => void;
  deps: SkillCredentialDeps;
}): Promise<string> {
  const { skill, sbx, dest, ctx, markCredentialInjected, deps } = opts;
  if (!skill.credentials.length) return '';
  if (sbx.supportsSecretFiles === false) {
    return '\n注意：本地沙箱不支持安全凭据文件，未获取或注入平台凭据。';
  }
  if (!deps.credentials || !ctx.tenantId || !ctx.userId) {
    return '\n注意：该技能需要平台凭据，但当前环境未启用凭据注入。';
  }
  const relFile = normalizeCredentialFile(skill.credentialFile ?? 'token.json');
  const filePath = posix.join(dest, relFile);
  const notes: string[] = [];
  const providers: Record<string, unknown> = {};
  for (const provider of skill.credentials) {
    const payload = await deps.credentials.get(ctx.tenantId, ctx.userId, provider);
    if (payload === undefined) {
      notes.push(`\n注意：未找到当前用户的 ${provider} 凭据。请提示用户在 ${provider.toUpperCase()} 平台重新登录后重试；绝不要在对话中向用户索要密码。`);
      continue;
    }
    providers[provider] = payload;
  }
  if (!Object.keys(providers).length) return notes.join('');
  if (!sbx.writeFile) return `${notes.join('')}\n注意：当前沙箱不支持安全文件上传，未注入平台凭据。`;
  try {
    const providerNames = Object.keys(providers);
    const document = skill.credentials.length === 1 ? providers[providerNames[0]!] : { providers };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await sbx.writeFile(filePath, bytes, { mode: 0o600 });
  } catch (error) {
    return `${notes.join('')}\n注意：凭据写入沙箱失败：${String(error)}`;
  }
  for (const provider of Object.keys(providers)) {
    markCredentialInjected();
    await deps.audit?.record({
      kind: 'sandbox', action: 'credential-injected', tenantId: ctx.tenantId,
      sessionId: ctx.sessionId, tool: 'skill__sync_to_sandbox',
      detail: { skill: skill.name, provider, file: relFile },
    });
    log.info({ skill: skill.name, provider, sessionId: ctx.sessionId }, 'skill credential injected');
    notes.push(`\n已按当前用户注入 ${provider} 凭据（${relFile}），脚本可直接使用，无需登录。`);
  }
  return notes.join('');
}
