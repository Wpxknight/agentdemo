import { posix } from 'node:path';
import { logger } from '../logger.js';
import type { ToolContext } from '../agent/tools.js';
import type { UserCredentials } from '../auth/credentials.js';
import type { AuditSink } from '../audit/sink.js';
import type { ExecResult, SandboxHandle } from '../sandbox/types.js';
import type { Skill } from './product.js';
import { normalizeCredentialFile } from './product.js';

const log = logger.child({ mod: 'skill-credentials' });

export interface SkillCredentialDeps {
  credentials?: UserCredentials;
  audit?: AuditSink;
}

export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function failed(result: ExecResult): boolean {
  return Boolean(result.error) || (typeof result.exitCode === 'number' && result.exitCode !== 0);
}

function execErrorText(result: ExecResult): string {
  return result.error || result.stderr.trim() || `exit code ${result.exitCode}`;
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
  if (!deps.credentials || !ctx.tenantId || !ctx.userId) {
    return '\n注意：该技能需要平台凭据，但当前环境未启用凭据注入。';
  }
  const relFile = normalizeCredentialFile(skill.credentialFile ?? 'token.json');
  const filePath = posix.join(dest, relFile);
  const fileDir = posix.dirname(filePath);
  const notes: string[] = [];
  for (const provider of skill.credentials) {
    const payload = await deps.credentials.get(ctx.tenantId, ctx.userId, provider);
    if (payload === undefined) {
      notes.push(`\n注意：未找到当前用户的 ${provider} 凭据。请提示用户在 ${provider.toUpperCase()} 平台重新登录后重试；绝不要在对话中向用户索要密码。`);
      continue;
    }
    const b64 = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
    const write = await sbx.runCommand(
      `mkdir -p ${quotePosix(fileDir)} && printf '%s' ${quotePosix(b64)} | base64 -d > ${quotePosix(filePath)} && chmod 600 ${quotePosix(filePath)} && echo AIOP_CRED_OK`,
    );
    if (failed(write) || !write.stdout.includes('AIOP_CRED_OK')) {
      notes.push(`\n注意：${provider} 凭据写入沙箱失败：${execErrorText(write)}`);
      continue;
    }
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
