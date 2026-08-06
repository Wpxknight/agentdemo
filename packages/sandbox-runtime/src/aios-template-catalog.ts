import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from './logger.js';
import {
  AiosLifecycleHttpClient,
  type AiosLifecycleHttpOptions,
} from './aios-http.js';
import type { SandboxProfile } from './profiles.js';

export type AiosTemplateEnvType = 'code' | 'browser';
export type SandboxRuntimeRole = 'sandbox-reader' | 'sandbox-diag';

export interface AiosTemplateCatalogEntry {
  templateId: string;
  name: string;
  aliases: string[];
  description: string;
  envType: AiosTemplateEnvType;
  runtimeRole: SandboxRuntimeRole;
  image: string;
  defaultTimeoutMs?: number;
}

export interface AiosTemplateCatalogSnapshot {
  templates: AiosTemplateCatalogEntry[];
  fingerprint: string;
  loadedAt: string;
}

const AiosMetadataSchema = z.object({
  description: z.string(),
  envType: z.enum(['code', 'browser']),
  runtimeRole: z.enum(['sandbox-reader', 'sandbox-diag']),
  image: z.string(),
  defaultTimeoutHours: z.number().int().nonnegative(),
}).strict();

const BaseTemplateSchema = z.object({
  templateID: z.string().trim().min(1),
  names: z.array(z.string()),
  aliases: z.array(z.string()),
  buildStatus: z.string(),
}).passthrough();

const MAX_SAFE_TIMEOUT_HOURS = Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000);
const REDACTED_TEMPLATE_ID = '[redacted]';

type ValidTemplate = z.infer<typeof BaseTemplateSchema>;
type ValidAiosMetadata = z.infer<typeof AiosMetadataSchema>;

function warningTemplateId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const templateId = (value as Record<string, unknown>).templateID;
  if (typeof templateId !== 'string' || !templateId.trim()) return undefined;
  return REDACTED_TEMPLATE_ID;
}

function warnIgnoredTemplate(index: number, value: unknown, validationClass: string): void {
  logger.warn({
    index,
    ...(warningTemplateId(value) ? { templateId: REDACTED_TEMPLATE_ID } : {}),
    validationClass,
  }, 'ignoring AIOS template catalog entry');
}

function warnLegacyTemplates(count: number): void {
  logger.warn({
    count,
    validationClass: 'legacy_compatibility',
  }, 'using least-privilege defaults for AIOS template catalog entries');
}

function trimmedUniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function canonicalStrings(values: readonly string[]): string[] {
  return trimmedUniqueStrings(values).sort(compareText);
}

function normalizeTemplate(
  template: ValidTemplate,
  metadata?: ValidAiosMetadata,
): AiosTemplateCatalogEntry | undefined {
  const names = trimmedUniqueStrings(template.names);
  if (!names.length || (metadata && metadata.defaultTimeoutHours > MAX_SAFE_TIMEOUT_HOURS)) return undefined;
  const name = names[0]!;

  return {
    templateId: template.templateID,
    name,
    aliases: canonicalStrings(template.aliases),
    description: metadata?.description ?? name,
    envType: metadata?.envType ?? 'code',
    runtimeRole: metadata?.runtimeRole ?? 'sandbox-reader',
    image: metadata?.image ?? '',
    ...(metadata && metadata.defaultTimeoutHours > 0
      ? { defaultTimeoutMs: metadata.defaultTimeoutHours * 3_600_000 }
      : {}),
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareEntries(left: AiosTemplateCatalogEntry, right: AiosTemplateCatalogEntry): number {
  return compareText(left.name, right.name) || compareText(left.templateId, right.templateId);
}

function fingerprint(entries: readonly AiosTemplateCatalogEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function sandboxProfilesFromAiosCatalog(
  entries: readonly AiosTemplateCatalogEntry[],
): SandboxProfile[] {
  return entries.map((entry) => {
    const capabilities = entry.envType === 'browser'
      ? ['shell', 'browser', 'screenshot', 'navigate', 'click', 'type']
      : ['python', 'node', 'shell'];
    if (entry.runtimeRole === 'sandbox-diag') capabilities.push('diagnostics');
    return {
      id: entry.templateId,
      template: entry.templateId,
      name: entry.name,
      description: entry.description,
      envType: entry.envType,
      runtimeRole: entry.runtimeRole,
      image: entry.image,
      desktop: entry.envType === 'browser',
      privileged: entry.runtimeRole === 'sandbox-diag',
      capabilities,
      ...(entry.defaultTimeoutMs ? { timeoutMs: entry.defaultTimeoutMs } : {}),
    };
  });
}

export class AiosTemplateCatalog {
  private readonly client: AiosLifecycleHttpClient;

  constructor(opts: AiosLifecycleHttpOptions) {
    this.client = new AiosLifecycleHttpClient(opts);
  }

  async load(): Promise<AiosTemplateCatalogSnapshot> {
    const { body } = await this.client.requestJson<unknown>('/templates');
    if (!Array.isArray(body)) {
      throw new Error('AIOS Lifecycle returned an invalid template catalog');
    }

    const explicitMetadataTemplateIds = new Set<string>();
    const malformedMetadataTemplateIds = new Set<string>();
    for (const value of body) {
      const parsed = BaseTemplateSchema.safeParse(value);
      if (!parsed.success || !Object.prototype.hasOwnProperty.call(value, 'aios')) continue;
      const metadata = AiosMetadataSchema.safeParse((value as Record<string, unknown>).aios);
      if (metadata.success) explicitMetadataTemplateIds.add(parsed.data.templateID);
      else malformedMetadataTemplateIds.add(parsed.data.templateID);
    }

    const seenTemplateIds = new Set<string>();
    const templates: AiosTemplateCatalogEntry[] = [];
    let legacyTemplateCount = 0;
    body.forEach((value, index) => {
      const parsed = BaseTemplateSchema.safeParse(value);
      if (!parsed.success) {
        warnIgnoredTemplate(index, value, 'schema');
        return;
      }
      const hasAiosMetadata = Object.prototype.hasOwnProperty.call(value, 'aios');
      if (!hasAiosMetadata && (
        explicitMetadataTemplateIds.has(parsed.data.templateID)
        || malformedMetadataTemplateIds.has(parsed.data.templateID)
      )) {
        warnIgnoredTemplate(index, value, 'duplicate');
        return;
      }
      const metadata = hasAiosMetadata
        ? AiosMetadataSchema.safeParse((value as Record<string, unknown>).aios)
        : undefined;
      if (metadata && !metadata.success) {
        warnIgnoredTemplate(index, value, 'schema');
        return;
      }
      if (parsed.data.buildStatus !== 'ready') {
        warnIgnoredTemplate(index, value, 'build_status');
        return;
      }
      const normalized = normalizeTemplate(parsed.data, metadata?.data);
      if (!normalized) {
        warnIgnoredTemplate(index, value, 'normalization');
        return;
      }
      if (seenTemplateIds.has(normalized.templateId)) {
        warnIgnoredTemplate(index, value, 'duplicate');
        return;
      }
      seenTemplateIds.add(normalized.templateId);
      templates.push(normalized);
      if (!hasAiosMetadata) legacyTemplateCount++;
    });

    if (legacyTemplateCount) warnLegacyTemplates(legacyTemplateCount);
    templates.sort(compareEntries);
    if (!templates.length) {
      throw new Error('AIOS Lifecycle template catalog has no usable templates');
    }
    return {
      templates,
      fingerprint: fingerprint(templates),
      loadedAt: new Date().toISOString(),
    };
  }
}
