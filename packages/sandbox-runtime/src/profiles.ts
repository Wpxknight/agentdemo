import type { Role, SandboxConfig } from './contracts.js';
import { sandboxIdentityKey, sandboxIdentityMetadata, sandboxScopedKey, type SandboxIdentity } from './keys.js';
import type { SandboxSpec } from './types.js';

export type SandboxProfileEnvType = 'code' | 'browser';
export type SandboxProfileRuntimeRole = 'sandbox-reader' | 'sandbox-diag';

export interface SandboxProfile {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: SandboxProfileEnvType;
  runtimeRole: SandboxProfileRuntimeRole;
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  envs?: Record<string, string>;
  timeoutMs?: number;
}

export interface PublicSandboxProfile {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: SandboxProfileEnvType;
  runtimeRole: SandboxProfileRuntimeRole;
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  timeoutMs?: number;
}

function defaultCapabilities(config: SandboxConfig): string[] {
  return config.desktop
    ? ['python', 'node', 'shell', 'browser', 'screenshot']
    : ['python', 'node', 'shell'];
}

function defaultProfile(config: SandboxConfig): SandboxProfile {
  return {
    id: 'default',
    name: 'default',
    description: config.desktop ? '默认会话沙箱，支持代码、命令和浏览器操作。' : '默认会话沙箱，支持代码和命令执行。',
    envType: 'code',
    runtimeRole: 'sandbox-reader',
    image: config.defaultImage,
    domain: config.domain,
    desktop: config.desktop,
    privileged: false,
    capabilities: defaultCapabilities(config),
    timeoutMs: config.timeoutMs,
  };
}

export function resolveSandboxProfiles(config: SandboxConfig | undefined): SandboxProfile[] {
  if (!config?.enabled) return [];
  const entries = Object.entries(config.profiles ?? {});
  if (!entries.length) return [defaultProfile(config)];

  const profiles: SandboxProfile[] = entries.map(([name, profile]) => {
    const desktop = profile.desktop ?? (name === 'default' ? config.desktop : false);
    const browserProfile = desktop && name !== 'default' && name !== 'code';
    const normalized: SandboxProfile = {
      id: name,
      name,
      description: profile.description || `${name} 沙箱模板`,
      // 非 AIOS 显式 code/default profile 可带 desktop，表示同一镜像兼具代码和浏览器能力。
      envType: browserProfile ? 'browser' : 'code',
      runtimeRole: 'sandbox-reader',
      desktop,
      privileged: Boolean(profile.privileged),
      capabilities: profile.capabilities ?? [],
    };
    const template = profile.template;
    const image = profile.image ?? (name === 'default' ? config.defaultImage : undefined);
    const domain = profile.domain ?? (name === 'default' ? config.domain : undefined);
    const timeoutMs = profile.timeoutMs ?? config.timeoutMs;
    if (template) normalized.template = template;
    if (image) normalized.image = image;
    if (domain) normalized.domain = domain;
    if (profile.namespace) normalized.namespace = profile.namespace;
    if (profile.serviceAccount) normalized.serviceAccount = profile.serviceAccount;
    if (profile.envs) normalized.envs = profile.envs;
    if (timeoutMs) normalized.timeoutMs = timeoutMs;
    return normalized;
  });

  if (!profiles.some((profile) => profile.name === 'default') && !profiles.some((profile) => profile.name === 'code')) {
    profiles.unshift(defaultProfile(config));
  }
  return profiles;
}

function profileId(profile: SandboxProfile): string {
  return profile.id;
}

function profileEnvType(profile: SandboxProfile): SandboxProfileEnvType {
  return profile.envType;
}

function profileRuntimeRole(profile: SandboxProfile): SandboxProfileRuntimeRole {
  return profile.runtimeRole;
}

export function publicSandboxProfile(profile: SandboxProfile): PublicSandboxProfile {
  return {
    id: profileId(profile),
    name: profile.name,
    ...(profile.template ? { template: profile.template } : {}),
    description: profile.description,
    envType: profileEnvType(profile),
    runtimeRole: profileRuntimeRole(profile),
    ...(profile.image ? { image: profile.image } : {}),
    ...(profile.domain ? { domain: profile.domain } : {}),
    ...(profile.namespace ? { namespace: profile.namespace } : {}),
    ...(profile.serviceAccount ? { serviceAccount: profile.serviceAccount } : {}),
    desktop: profile.desktop,
    privileged: profile.privileged,
    capabilities: [...profile.capabilities],
    ...(profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
  };
}

export function publicSandboxProfiles(profiles: SandboxProfile[]): PublicSandboxProfile[] {
  return profiles.map(publicSandboxProfile);
}

export function canUseSandboxProfile(profile: SandboxProfile, role: Role): boolean {
  return profileRuntimeRole(profile) !== 'sandbox-diag' || role === 'platform_admin';
}

export function visibleSandboxProfiles(profiles: SandboxProfile[], role: Role): SandboxProfile[] {
  return profiles.filter((profile) => canUseSandboxProfile(profile, role));
}

function authorizedCodeProfiles(profiles: SandboxProfile[], role: Role): SandboxProfile[] {
  return visibleSandboxProfiles(profiles, role).filter((profile) => profileEnvType(profile) === 'code');
}

export function selectDefaultProfile(
  profiles: SandboxProfile[],
  role: Role = 'platform_admin',
): SandboxProfile | undefined {
  const allowed = authorizedCodeProfiles(profiles, role);
  return allowed.find((profile) => profile.name === 'code-interpreter')
    ?? allowed.find((profile) => profile.name === 'code')
    ?? allowed.find((profile) => profile.name === 'default')
    ?? allowed[0];
}

export function selectBrowserProfile(
  profiles: SandboxProfile[],
  role: Role = 'platform_admin',
  options: { fallbackToCode?: boolean } = {},
): SandboxProfile | undefined {
  const visible = visibleSandboxProfiles(profiles, role);
  const browser = visible.filter((profile) => profileEnvType(profile) === 'browser');
  const selected = browser.find((profile) => profile.name === 'browser') ?? browser[0];
  if (selected || !options.fallbackToCode) return selected;

  const desktopCode = visible.filter((profile) => profile.desktop && profileEnvType(profile) === 'code');
  return desktopCode.find((profile) => profile.name === 'default')
    ?? desktopCode.find((profile) => profile.name === 'code')
    ?? desktopCode[0];
}

export function findSandboxProfile(
  profiles: SandboxProfile[],
  selector?: string,
  role: Role = 'platform_admin',
): SandboxProfile {
  if (!selector) {
    const selected = selectDefaultProfile(profiles, role);
    if (!selected) throw new Error('当前身份没有可用的代码沙箱模板');
    return selected;
  }
  const byId = profiles.find((profile) => profileId(profile) === selector);
  const nameMatches = profiles.filter((profile) => profile.name === selector);
  const selected = byId ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
  if (!selected) throw new Error(`未配置沙箱模板: ${selector}`);
  if (!canUseSandboxProfile(selected, role)) {
    throw new Error('当前身份无权使用该沙箱模板；sandbox-diag 仅 platform_admin 可用');
  }
  return selected;
}

export function sandboxProfileKey(identity: SandboxIdentity, profile: SandboxProfile): string {
  const id = profileId(profile);
  return id === 'default'
    ? sandboxIdentityKey(identity)
    : sandboxScopedKey(identity, `profile:${id}`);
}

export function sandboxSpecForProfile(profile: SandboxProfile, ctx: SandboxIdentity): SandboxSpec {
  const id = profileId(profile);
  return {
    key: sandboxProfileKey(ctx, profile),
    profile: id,
    template: profile.template ?? profile.image,
    domain: profile.domain,
    namespace: profile.namespace,
    serviceAccount: profile.serviceAccount,
    timeoutMs: profile.timeoutMs,
    envs: {
      ...profile.envs,
      AIOP_SANDBOX_PROFILE: id,
    },
    metadata: {
      ...sandboxIdentityMetadata(ctx),
      profile: id,
      ...(profile.privileged ? { privileged: 'true' } : {}),
      ...(profile.capabilities.length ? { capabilities: profile.capabilities.join(',') } : {}),
    },
  };
}
