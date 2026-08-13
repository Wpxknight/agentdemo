import type { OutputSink } from './types.js';

export type Role = 'platform_admin' | 'tenant_admin' | 'user';

export interface RequestContext {
  tenantId: string;
  userId: string;
  role: Role;
}

export interface ToolContext {
  sessionId: string;
  tenantId?: string;
  userId?: string;
  role?: Role;
  signal?: AbortSignal;
  onOutput?: OutputSink;
  [key: string]: unknown;
}

export interface SandboxProfileConfig {
  template?: string;
  image?: string;
  description?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop?: boolean;
  privileged: boolean;
  capabilities: string[];
  envs?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxConfig {
  enabled: boolean;
  provider: 'local' | 'e2b' | 'opensandbox';
  apiKey?: string;
  aios?: {
    lifecycleUrl: string;
    placement?: { clusterId?: string; clusterName?: string; namespace?: string };
    clusterDirectory?: Readonly<Record<string, string>>;
  };
  domain?: string;
  protocol?: 'http' | 'https';
  defaultImage?: string;
  idleMs?: number;
  timeoutMs?: number;
  desktop: boolean;
  warmPoolSize?: number;
  profiles?: Record<string, SandboxProfileConfig>;
  userHomeRoot?: string;
  userHomeMountPath: string;
}

export interface SandboxSettings {
  enabled: boolean;
  mode: 'standard_e2b' | 'aios_lifecycle' | 'opensandbox' | 'local';
  domain?: string;
  protocol?: 'http' | 'https';
  defaultImage?: string;
  lifecycleUrl?: string;
  /** @deprecated 仅供旧数据库记录作为内部 fallback，公共设置不再返回或保存。 */
  placement?: { clusterId?: string; clusterName?: string; namespace?: string };
}

export interface SandboxSettingsRecord {
  settings: SandboxSettings;
  encryptedApiKey?: string;
}

export type SandboxSettingsSecretUpdate =
  | { action: 'retain' }
  | { action: 'replace'; encryptedApiKey: string }
  | { action: 'clear' };

export interface SandboxSettingsStore {
  getSandboxSettingsRecord(ctx: { tenantId: string }): Promise<SandboxSettingsRecord | undefined>;
  setSandboxSettingsRecord(
    ctx: { tenantId: string },
    settings: SandboxSettings,
    secret: SandboxSettingsSecretUpdate,
  ): Promise<void>;
}

export interface SecretBoxLike {
  seal(plain: string): string;
  open(envelope: string): string;
}
