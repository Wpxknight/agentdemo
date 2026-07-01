import type { SandboxConfig } from '../config/schema.js';
import type { SandboxSpec } from './types.js';

export interface SandboxProfile {
  name: string;
  description: string;
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
  name: string;
  description: string;
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  timeoutMs?: number;
}

function legacyCapabilities(config: SandboxConfig): string[] {
  return config.desktop
    ? ['python', 'node', 'shell', 'browser', 'screenshot']
    : ['python', 'node', 'shell'];
}

function legacyProfile(config: SandboxConfig): SandboxProfile {
  return {
    name: 'default',
    description: config.desktop ? '默认会话沙箱，支持代码、命令和浏览器操作。' : '默认会话沙箱，支持代码和命令执行。',
    image: config.defaultImage,
    domain: config.domain,
    desktop: config.desktop,
    privileged: false,
    capabilities: legacyCapabilities(config),
    timeoutMs: config.timeoutMs,
  };
}

export function resolveSandboxProfiles(config: SandboxConfig | undefined): SandboxProfile[] {
  if (!config?.enabled) return [];
  const entries = Object.entries(config.profiles ?? {});
  if (!entries.length) return [legacyProfile(config)];

  const profiles: SandboxProfile[] = entries.map(([name, profile]) => {
    const normalized: SandboxProfile = {
      name,
      description: profile.description || `${name} 沙箱模板`,
      desktop: profile.desktop ?? (name === 'default' ? config.desktop : false),
      privileged: Boolean(profile.privileged),
      capabilities: profile.capabilities ?? [],
    };
    const image = profile.image ?? profile.template ?? (name === 'default' ? config.defaultImage : undefined);
    const domain = profile.domain ?? (name === 'default' ? config.domain : undefined);
    const timeoutMs = profile.timeoutMs ?? config.timeoutMs;
    if (image) normalized.image = image;
    if (domain) normalized.domain = domain;
    if (profile.namespace) normalized.namespace = profile.namespace;
    if (profile.serviceAccount) normalized.serviceAccount = profile.serviceAccount;
    if (profile.envs) normalized.envs = profile.envs;
    if (timeoutMs) normalized.timeoutMs = timeoutMs;
    return normalized;
  });

  if (!profiles.some((profile) => profile.name === 'default') && !profiles.some((profile) => profile.name === 'code')) {
    profiles.unshift(legacyProfile(config));
  }
  return profiles;
}

export function publicSandboxProfile(profile: SandboxProfile): PublicSandboxProfile {
  return {
    name: profile.name,
    description: profile.description,
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

export function selectDefaultProfile(profiles: SandboxProfile[]): SandboxProfile | undefined {
  return profiles.find((profile) => profile.name === 'code')
    ?? profiles.find((profile) => profile.name === 'default')
    ?? profiles[0];
}

export function selectBrowserProfile(profiles: SandboxProfile[]): SandboxProfile | undefined {
  return profiles.find((profile) => profile.name === 'browser')
    ?? profiles.find((profile) => profile.desktop)
    ?? selectDefaultProfile(profiles);
}

export function findSandboxProfile(profiles: SandboxProfile[], name?: string): SandboxProfile {
  const selected = name
    ? profiles.find((profile) => profile.name === name)
    : selectDefaultProfile(profiles);
  if (!selected) throw new Error('未配置可用沙箱模板');
  return selected;
}

export function sandboxProfileKey(sessionId: string, profile: SandboxProfile): string {
  return profile.name === 'default' ? sessionId : `${sessionId}:profile:${profile.name}`;
}

export function sandboxSpecForProfile(profile: SandboxProfile, ctx: { sessionId: string }): SandboxSpec {
  return {
    key: sandboxProfileKey(ctx.sessionId, profile),
    profile: profile.name,
    template: profile.image,
    domain: profile.domain,
    namespace: profile.namespace,
    serviceAccount: profile.serviceAccount,
    timeoutMs: profile.timeoutMs,
    envs: {
      ...profile.envs,
      AIOP_SANDBOX_PROFILE: profile.name,
    },
    metadata: {
      sessionId: ctx.sessionId,
      profile: profile.name,
      ...(profile.privileged ? { privileged: 'true' } : {}),
      ...(profile.capabilities.length ? { capabilities: profile.capabilities.join(',') } : {}),
    },
  };
}
