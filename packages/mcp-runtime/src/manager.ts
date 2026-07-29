import type { IdentityContext } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import { McpRuntime } from './runtime.js';
import type {
  McpConnectFn,
  McpRuntimeOptions,
  McpServerConfig,
  McpServerInfo,
} from './types.js';

export interface McpManagerOptions extends Omit<McpRuntimeOptions, 'connect'> {
  loadConfigs?(identity: IdentityContext): Promise<Record<string, McpServerConfig> | undefined>;
}

export class McpManager {
  private readonly runtime: McpRuntime;
  private readonly initialized = new Map<string, Promise<void>>();

  constructor(
    private readonly initial: Record<string, McpServerConfig>,
    connect: McpConnectFn,
    private readonly options: McpManagerOptions = {},
  ) {
    this.runtime = new McpRuntime({ ...options, connect });
  }

  async start(identity: IdentityContext): Promise<void> {
    await this.tools(identity);
  }

  async tools(identity: IdentityContext): Promise<GovernedToolDefinition[]> {
    await this.ensureConfigured(identity);
    return this.runtime.discover(identity);
  }

  async add(
    identity: IdentityContext,
    name: string,
    config: McpServerConfig,
  ): Promise<McpServerInfo> {
    await this.ensureConfigured(identity);
    return this.runtime.add(identity, name, config);
  }

  async remove(identity: IdentityContext, name: string): Promise<boolean> {
    await this.ensureConfigured(identity);
    return this.runtime.remove(identity, name);
  }

  async reconnect(identity: IdentityContext, name: string): Promise<McpServerInfo> {
    await this.ensureConfigured(identity);
    return this.runtime.reconnect(identity, name);
  }

  async info(identity: IdentityContext, name: string): Promise<McpServerInfo | undefined> {
    await this.ensureConfigured(identity);
    return this.runtime.info(identity, name);
  }

  async list(identity: IdentityContext): Promise<McpServerInfo[]> {
    await this.ensureConfigured(identity);
    return this.runtime.list(identity);
  }

  async configs(identity: IdentityContext): Promise<Record<string, McpServerConfig>> {
    await this.ensureConfigured(identity);
    return this.runtime.configs(identity);
  }

  async close(): Promise<void> {
    this.initialized.clear();
    await this.runtime.close();
  }

  private ensureConfigured(identity: IdentityContext): Promise<void> {
    const existing = this.initialized.get(identity.tenantId);
    if (existing) return existing;
    const configuring = (async () => {
      const loaded = await this.options.loadConfigs?.(identity);
      await this.runtime.configure(identity, loaded ?? this.initial);
    })();
    this.initialized.set(identity.tenantId, configuring);
    void configuring.catch(() => {
      if (this.initialized.get(identity.tenantId) === configuring) {
        this.initialized.delete(identity.tenantId);
      }
    });
    return configuring;
  }
}
