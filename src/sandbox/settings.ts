import { z } from 'zod';
import type { SandboxConfig } from '../config/schema.js';
import type {
  SandboxSettings,
  SandboxSettingsRecord,
  SandboxSettingsSecretUpdate,
  Store,
} from '../db/store.js';
import type { SecretBox } from '../security/secret-box.js';

const PLATFORM_SETTINGS_CONTEXT = { tenantId: 'default' } as const;
const SECRET_SCHEMA_VERSION = 1;

const EnabledModeSchema = z.object({
  enabled: z.boolean(),
});

const LocalSettingsSchema = EnabledModeSchema.extend({
  mode: z.literal('local'),
}).strict();

const DomainSchema = z.string().trim().min(1).transform(normalizeDomain);

const StandardE2bSettingsSchema = EnabledModeSchema.extend({
  mode: z.literal('standard_e2b'),
  domain: DomainSchema.optional(),
}).strict();

const OpenSandboxSettingsSchema = EnabledModeSchema.extend({
  mode: z.literal('opensandbox'),
  domain: DomainSchema.optional(),
  protocol: z.enum(['http', 'https']).optional(),
  defaultImage: z.string().trim().min(1).optional(),
}).strict();

const AiosLifecycleSettingsSchema = EnabledModeSchema.extend({
  mode: z.literal('aios_lifecycle'),
  lifecycleUrl: z.string().trim().min(1).transform(normalizeLifecycleUrl),
  placement: z.object({
    clusterId: z.string().trim().min(1),
    namespace: z.string().trim().min(1),
  }).strict(),
}).strict();

export const SandboxSettingsSchema = z.discriminatedUnion('mode', [
  StandardE2bSettingsSchema,
  AiosLifecycleSettingsSchema,
  OpenSandboxSettingsSchema,
  LocalSettingsSchema,
]);

interface StoredSecretV1 {
  schemaVersion: 1;
  apiKey: string;
  target: string;
}

export type SandboxApiKeyUpdate =
  | { action: 'retain' }
  | { action: 'replace'; apiKey: string }
  | { action: 'clear' };

export interface LoadedSandboxSettings {
  settings: SandboxSettings;
  apiKey?: string;
  apiKeySet: boolean;
}

export interface ParsedStoredSandboxSettings {
  settings: SandboxSettings;
  legacyApiKey?: string;
}

function normalizeDomain(value: string): string {
  if (value.includes('://')) throw new Error('domain 必须是 host[:port]，不能包含 scheme');
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    throw new Error('domain 必须是有效的 host[:port]');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new Error('domain 必须是 host[:port]，不能包含路径或凭据');
  }
  return url.host.toLowerCase();
}

function normalizeLifecycleUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('lifecycleUrl 必须是完整 HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('lifecycleUrl 必须是无凭据、查询和片段的完整 HTTP(S) URL');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function legacySettings(value: Record<string, unknown>): SandboxSettings {
  const provider = value.provider;
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true;
  const legacyAios = value.aios && typeof value.aios === 'object' && !Array.isArray(value.aios)
    ? value.aios as Record<string, unknown>
    : undefined;
  const placement = legacyAios?.placement && typeof legacyAios.placement === 'object' && !Array.isArray(legacyAios.placement)
    ? legacyAios.placement as Record<string, unknown>
    : undefined;
  const lifecycleUrl = stringValue(value.lifecycleUrl) ?? stringValue(legacyAios?.lifecycleUrl);

  if (lifecycleUrl || legacyAios) {
    return parseSandboxSettings({
      enabled,
      mode: 'aios_lifecycle',
      lifecycleUrl,
      placement: {
        clusterId: stringValue(value.clusterId) ?? stringValue(placement?.clusterId),
        namespace: stringValue(value.namespace) ?? stringValue(placement?.namespace),
      },
    });
  }
  if (provider === 'local') return { enabled, mode: 'local' };
  if (provider === 'opensandbox') {
    return parseSandboxSettings({
      enabled,
      mode: 'opensandbox',
      domain: stringValue(value.domain),
      protocol: value.protocol,
      defaultImage: stringValue(value.defaultImage),
    });
  }
  if (provider === undefined || provider === 'e2b') {
    return parseSandboxSettings({ enabled, mode: 'standard_e2b', domain: stringValue(value.domain) });
  }
  throw new Error('旧版 sandbox provider 无效');
}

function parseStoredSecret(box: SecretBox, encrypted: string): StoredSecretV1 {
  let value: unknown;
  try {
    value = JSON.parse(box.open(encrypted));
  } catch (err) {
    if (err instanceof Error && err.message === '设置凭据无法解密，请重新配置') throw err;
    throw new Error('设置凭据无法解密，请重新配置');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置凭据无法解密，请重新配置');
  const secret = value as Partial<StoredSecretV1>;
  if (
    secret.schemaVersion !== SECRET_SCHEMA_VERSION
    || typeof secret.apiKey !== 'string'
    || !secret.apiKey
    || typeof secret.target !== 'string'
    || !secret.target
  ) {
    throw new Error('设置凭据无法解密，请重新配置');
  }
  return secret as StoredSecretV1;
}

function encryptedSecret(box: SecretBox, settings: SandboxSettings, apiKey: string): string {
  const payload: StoredSecretV1 = {
    schemaVersion: SECRET_SCHEMA_VERSION,
    apiKey,
    target: credentialTargetForSandboxSettings(settings),
  };
  return box.seal(JSON.stringify(payload));
}

function requiresApiKey(settings: SandboxSettings): boolean {
  return settings.enabled && (settings.mode === 'standard_e2b' || settings.mode === 'aios_lifecycle');
}

export function parseSandboxSettings(value: unknown): SandboxSettings {
  return SandboxSettingsSchema.parse(value) as SandboxSettings;
}

/** 读取显式 v2 设置，或把旧 provider/apiKey JSON 转换为新模式并提取明文 key。 */
export function parseStoredSandboxSettings(value: unknown): ParsedStoredSandboxSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sandbox settings 格式无效');
  const input = value as Record<string, unknown>;
  const settings = 'mode' in input ? parseSandboxSettings(input) : legacySettings(input);
  const legacyApiKey = stringValue(input.apiKey);
  return { settings, ...(legacyApiKey ? { legacyApiKey } : {}) };
}

/** key 只与模式和规范化远端目标绑定；AIOS placement 不改变凭据目标。 */
export function credentialTargetForSandboxSettings(settings: SandboxSettings): string {
  switch (settings.mode) {
    case 'standard_e2b':
      return `standard_e2b:${settings.domain ?? 'default'}`;
    case 'aios_lifecycle':
      if (!settings.lifecycleUrl) throw new Error('AIOS Lifecycle 设置缺少 lifecycleUrl');
      return `aios_lifecycle:${settings.lifecycleUrl}`;
    case 'opensandbox':
      return `opensandbox:${settings.protocol ?? 'http'}://${settings.domain ?? 'default'}`;
    case 'local':
      return 'local';
  }
}

/** 把已验证、已解密的页面设置转换成 provider 运行配置。 */
export function sandboxSettingsToConfig(settings: SandboxSettings, apiKey?: string): SandboxConfig {
  switch (settings.mode) {
    case 'local':
      return { enabled: settings.enabled, provider: 'local', desktop: false, userHomeMountPath: '/home/user/host' };
    case 'standard_e2b':
      return {
        enabled: settings.enabled,
        provider: 'e2b',
        ...(apiKey ? { apiKey } : {}),
        ...(settings.domain ? { domain: settings.domain } : {}),
        desktop: false,
        userHomeMountPath: '/home/user/host',
      };
    case 'opensandbox':
      return {
        enabled: settings.enabled,
        provider: 'opensandbox',
        ...(apiKey ? { apiKey } : {}),
        ...(settings.domain ? { domain: settings.domain } : {}),
        ...(settings.protocol ? { protocol: settings.protocol } : {}),
        ...(settings.defaultImage ? { defaultImage: settings.defaultImage } : {}),
        desktop: false,
        userHomeMountPath: '/home/user/host',
      };
    case 'aios_lifecycle':
      if (!settings.lifecycleUrl || !settings.placement) throw new Error('AIOS Lifecycle 设置缺少 URL 或 placement');
      return {
        enabled: settings.enabled,
        provider: 'e2b',
        ...(apiKey ? { apiKey } : {}),
        aios: { lifecycleUrl: settings.lifecycleUrl, placement: { ...settings.placement } },
        desktop: false,
        userHomeMountPath: '/home/user/host',
      };
  }
}

/** 平台 Sandbox 设置编排：加解密、目标绑定校验和配置+secret 原子保存。 */
export class SandboxSettingsPersistence {
  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly ctx: { tenantId: string } = PLATFORM_SETTINGS_CONTEXT,
  ) {}

  async load(): Promise<LoadedSandboxSettings | undefined> {
    const record = await this.store.getSandboxSettingsRecord(this.ctx);
    if (!record) return undefined;

    if (record.legacyApiKey) {
      const encryptedApiKey = encryptedSecret(this.box, record.settings, record.legacyApiKey);
      await this.store.setSandboxSettingsRecord(this.ctx, record.settings, { action: 'replace', encryptedApiKey });
      return { settings: record.settings, apiKey: record.legacyApiKey, apiKeySet: true };
    }
    if (!record.encryptedApiKey) return { settings: record.settings, apiKeySet: false };

    const secret = parseStoredSecret(this.box, record.encryptedApiKey);
    if (secret.target !== credentialTargetForSandboxSettings(record.settings)) {
      throw new Error('设置凭据目标不匹配，请重新配置');
    }
    return { settings: record.settings, apiKey: secret.apiKey, apiKeySet: true };
  }

  async save(input: SandboxSettings, update: SandboxApiKeyUpdate): Promise<LoadedSandboxSettings> {
    const settings = parseSandboxSettings(input);
    const current = await this.store.getSandboxSettingsRecord(this.ctx);
    let storedUpdate: SandboxSettingsSecretUpdate;
    let apiKey: string | undefined;

    if (update.action === 'replace') {
      apiKey = update.apiKey.trim();
      if (!apiKey) throw new Error('apiKey 不能为空；清除凭据请使用 clear');
      if (settings.mode === 'local') throw new Error('local 模式不支持 API key');
      storedUpdate = { action: 'replace', encryptedApiKey: encryptedSecret(this.box, settings, apiKey) };
    } else if (update.action === 'clear') {
      if (requiresApiKey(settings)) throw new Error('启用当前模式时必须配置 API key');
      storedUpdate = { action: 'clear' };
    } else {
      const retained = this.retainedSecret(current, settings);
      apiKey = retained?.apiKey;
      storedUpdate = current?.legacyApiKey && apiKey
        ? { action: 'replace', encryptedApiKey: encryptedSecret(this.box, settings, apiKey) }
        : { action: 'retain' };
      if (requiresApiKey(settings) && !apiKey) throw new Error('启用当前模式时必须配置 API key');
    }

    await this.store.setSandboxSettingsRecord(this.ctx, settings, storedUpdate);
    return { settings, ...(apiKey ? { apiKey } : {}), apiKeySet: Boolean(apiKey) };
  }

  private retainedSecret(record: SandboxSettingsRecord | undefined, settings: SandboxSettings): StoredSecretV1 | undefined {
    if (!record) return undefined;
    const secret = record.legacyApiKey
      ? {
          schemaVersion: 1 as const,
          apiKey: record.legacyApiKey,
          target: credentialTargetForSandboxSettings(record.settings),
        }
      : record.encryptedApiKey
        ? parseStoredSecret(this.box, record.encryptedApiKey)
        : undefined;
    if (secret && secret.target !== credentialTargetForSandboxSettings(settings)) {
      throw new Error('Sandbox 凭据目标已变化，请重新输入或清除 API key');
    }
    return secret;
  }
}
