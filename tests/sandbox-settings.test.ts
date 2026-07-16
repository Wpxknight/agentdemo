import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import type { RequestContext } from '../src/auth/types.js';
import type { Store } from '../src/db/store.js';
import { SecretBox, createSettingsSecretBox } from '../src/security/secret-box.js';
import {
  SandboxSettingsPersistence,
  credentialTargetForSandboxSettings,
  parseStoredSandboxSettings,
  parseSandboxSettings,
  sandboxSettingsToConfig,
} from '../src/sandbox/settings.js';

const platform: Pick<RequestContext, 'tenantId'> = { tenantId: 'default' };

describe('sandbox settings validation and conversion', () => {
  it('validates explicit modes and builds canonical AIOS config', () => {
    const settings = parseSandboxSettings({
      enabled: true,
      mode: 'aios_lifecycle',
      lifecycleUrl: 'https://sandbox.example.test/lifecycle/',
      placement: { clusterId: ' local ', namespace: ' sandbox-system ' },
    });

    expect(settings).toEqual({
      enabled: true,
      mode: 'aios_lifecycle',
      lifecycleUrl: 'https://sandbox.example.test/lifecycle',
      placement: { clusterId: 'local', namespace: 'sandbox-system' },
    });
    expect(sandboxSettingsToConfig(settings, 'configured-key')).toEqual({
      enabled: true,
      provider: 'e2b',
      apiKey: 'configured-key',
      aios: {
        lifecycleUrl: 'https://sandbox.example.test/lifecycle',
        placement: { clusterId: 'local', namespace: 'sandbox-system' },
      },
      desktop: false,
      profiles: {
        code: {
          description: 'AIOS code interpreter',
          image: 'code-interpreter',
          desktop: false,
          privileged: false,
          capabilities: ['python', 'node', 'shell'],
        },
      },
      userHomeMountPath: '/home/user/host',
    });
  });

  it('rejects fields belonging to another mode', () => {
    expect(() => parseSandboxSettings({
      enabled: true,
      mode: 'local',
      lifecycleUrl: 'https://sandbox.example.test',
    })).toThrow(/无法识别|不支持|unrecognized/i);

    expect(() => parseSandboxSettings({
      enabled: true,
      mode: 'opensandbox',
      domain: 'https://sandbox.example.test',
    })).toThrow(/domain/i);
  });

  it('converts legacy provider settings and extracts the legacy plaintext key', () => {
    expect(parseStoredSandboxSettings({
      provider: 'opensandbox',
      domain: 'Sandbox.EXAMPLE.test:8080',
      protocol: 'https',
      defaultImage: 'sandbox:latest',
      apiKey: 'legacy-key',
    })).toEqual({
      settings: {
        enabled: true,
        mode: 'opensandbox',
        domain: 'sandbox.example.test:8080',
        protocol: 'https',
        defaultImage: 'sandbox:latest',
      },
      legacyApiKey: 'legacy-key',
    });
  });

  it('normalizes credential targets without binding AIOS placement', () => {
    const first = parseSandboxSettings({
      enabled: true,
      mode: 'aios_lifecycle',
      lifecycleUrl: 'HTTPS://Sandbox.EXAMPLE.test/api/',
      placement: { clusterId: 'c1', namespace: 'n1' },
    });
    const moved = parseSandboxSettings({
      enabled: true,
      mode: 'aios_lifecycle',
      lifecycleUrl: 'https://sandbox.example.test/api',
      placement: { clusterId: 'c2', namespace: 'n2' },
    });

    expect(credentialTargetForSandboxSettings(first)).toBe('aios_lifecycle:https://sandbox.example.test/api');
    expect(credentialTargetForSandboxSettings(moved)).toBe(credentialTargetForSandboxSettings(first));
  });
});

describe('SecretBox', () => {
  it('roundtrips AES-GCM ciphertext without exposing plaintext', () => {
    const box = new SecretBox('settings-secret', 'platform-settings');
    const first = box.seal('sandbox-api-key');
    const second = box.seal('sandbox-api-key');

    expect(first).not.toContain('sandbox-api-key');
    expect(second).not.toBe(first);
    expect(box.open(first)).toBe('sandbox-api-key');
  });

  it('returns a safe error when the key is wrong', () => {
    const encrypted = new SecretBox('old-secret', 'platform-settings').seal('sandbox-api-key');
    expect(() => new SecretBox('new-secret', 'platform-settings').open(encrypted)).toThrow('设置凭据无法解密');
  });

  it('prefers AIOP_SETTINGS_SECRET and supports the documented JWT fallback', () => {
    const dedicated = createSettingsSecretBox({ AIOP_SETTINGS_SECRET: 'dedicated', AIOP_JWT_SECRET: 'jwt' });
    const fallback = createSettingsSecretBox({ AIOP_JWT_SECRET: 'jwt' });
    const dedicatedCipher = dedicated.seal('value');
    const fallbackCipher = fallback.seal('value');

    expect(dedicated.open(dedicatedCipher)).toBe('value');
    expect(fallback.open(fallbackCipher)).toBe('value');
    expect(() => fallback.open(dedicatedCipher)).toThrow('设置凭据无法解密');
  });
});

describe('SandboxSettingsPersistence', () => {
  it('stores only encrypted API keys and retains them for the same target', async () => {
    const store = new MemoryStore();
    const persistence = new SandboxSettingsPersistence(store, new SecretBox('settings-secret', 'platform-settings'));
    const settings = parseSandboxSettings({ enabled: true, mode: 'standard_e2b', domain: 'e2b.example.test' });

    await persistence.save(settings, { action: 'replace', apiKey: 'sandbox-api-key' });
    const stored = await store.getSandboxSettingsRecord(platform);

    expect(stored?.settings).toEqual(settings);
    expect(stored?.encryptedApiKey).toBeTypeOf('string');
    expect(stored?.encryptedApiKey).not.toContain('sandbox-api-key');
    expect(JSON.stringify(stored?.settings)).not.toContain('sandbox-api-key');
    expect(await persistence.load()).toEqual({ settings, apiKey: 'sandbox-api-key', apiKeySet: true });

    await persistence.save({ ...settings, enabled: false }, { action: 'retain' });
    expect(await persistence.load()).toEqual({
      settings: { ...settings, enabled: false },
      apiKey: 'sandbox-api-key',
      apiKeySet: true,
    });
  });

  it('requires replacement or clearing when the credential target changes', async () => {
    const store = new MemoryStore();
    const persistence = new SandboxSettingsPersistence(store, new SecretBox('settings-secret', 'platform-settings'));
    const current = parseSandboxSettings({ enabled: true, mode: 'standard_e2b', domain: 'old.example.test' });
    const next = parseSandboxSettings({ enabled: true, mode: 'standard_e2b', domain: 'new.example.test' });
    await persistence.save(current, { action: 'replace', apiKey: 'old-key' });

    await expect(persistence.save(next, { action: 'retain' })).rejects.toThrow(/目标.*变化|重新输入/i);
    await persistence.save(next, { action: 'replace', apiKey: 'new-key' });
    expect(await persistence.load()).toEqual({ settings: next, apiKey: 'new-key', apiKeySet: true });
  });

  it('rejects clearing a required key while enabled and allows disable plus clear', async () => {
    const store = new MemoryStore();
    const persistence = new SandboxSettingsPersistence(store, new SecretBox('settings-secret', 'platform-settings'));
    const enabled = parseSandboxSettings({
      enabled: true,
      mode: 'aios_lifecycle',
      lifecycleUrl: 'http://aios-sandbox-server:8080',
      placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
    });
    await persistence.save(enabled, { action: 'replace', apiKey: 'configured-key' });

    await expect(persistence.save(enabled, { action: 'clear' })).rejects.toThrow(/API key/i);
    await persistence.save({ ...enabled, enabled: false }, { action: 'clear' });
    expect(await persistence.load()).toEqual({ settings: { ...enabled, enabled: false }, apiKeySet: false });
  });

  it('migrates a legacy plaintext key on first load', async () => {
    let record = {
      settings: parseSandboxSettings({ enabled: true, mode: 'opensandbox', domain: 'sandbox.example.test' }),
      legacyApiKey: 'legacy-key',
    };
    const fakeStore = {
      async getSandboxSettingsRecord() { return record; },
      async setSandboxSettingsRecord(_ctx: unknown, settings: typeof record.settings, secret: { action: string; encryptedApiKey?: string }) {
        record = {
          settings,
          ...(secret.action === 'replace' ? { encryptedApiKey: secret.encryptedApiKey } : {}),
        } as typeof record;
      },
    } as unknown as Store;
    const persistence = new SandboxSettingsPersistence(fakeStore, new SecretBox('settings-secret', 'platform-settings'));

    expect(await persistence.load()).toEqual({
      settings: record.settings,
      apiKey: 'legacy-key',
      apiKeySet: true,
    });
    expect(record).not.toHaveProperty('legacyApiKey');
    expect(record).toHaveProperty('encryptedApiKey');
    expect(JSON.stringify(record)).not.toContain('legacy-key');
  });

  it('migrates a retained legacy key while atomically updating settings', async () => {
    const original = parseSandboxSettings({ enabled: true, mode: 'standard_e2b', domain: 'e2b.example.test' });
    let record = { settings: original, legacyApiKey: 'legacy-key' };
    let action = '';
    const fakeStore = {
      async getSandboxSettingsRecord() { return record; },
      async setSandboxSettingsRecord(_ctx: unknown, settings: typeof original, secret: { action: string; encryptedApiKey?: string }) {
        action = secret.action;
        record = {
          settings,
          ...(secret.encryptedApiKey ? { encryptedApiKey: secret.encryptedApiKey } : {}),
        } as typeof record;
      },
    } as unknown as Store;
    const persistence = new SandboxSettingsPersistence(fakeStore, new SecretBox('settings-secret', 'platform-settings'));

    const saved = await persistence.save({ ...original, enabled: false }, { action: 'retain' });

    expect(saved).toEqual({ settings: { ...original, enabled: false }, apiKey: 'legacy-key', apiKeySet: true });
    expect(action).toBe('replace');
    expect(record).not.toHaveProperty('legacyApiKey');
    expect(JSON.stringify(record)).not.toContain('legacy-key');
  });

  it('keeps MemoryStore records tenant scoped', async () => {
    const store = new MemoryStore();
    const settings = parseSandboxSettings({ enabled: false, mode: 'local' });
    await store.setSandboxSettingsRecord(platform, settings, { action: 'retain' });

    expect((await store.getSandboxSettingsRecord(platform))?.settings).toEqual(settings);
    expect(await store.getSandboxSettingsRecord({ tenantId: 'other' })).toBeUndefined();
  });

  it('has a dedicated MySQL secret table migration', async () => {
    const migration = await readFile('src/db/migrations/0010_setting_secrets.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS setting_secrets');
    expect(migration).toContain('payload');
    expect(migration).toContain('PRIMARY KEY (tenant_id, setting_key)');
  });
});
