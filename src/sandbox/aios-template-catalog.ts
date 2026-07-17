import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../logger.js';
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

const TemplateSchema = z.object({
  templateID: z.string().trim().min(1),
  names: z.array(z.string()),
  aliases: z.array(z.string()),
  buildStatus: z.string(),
  aios: AiosMetadataSchema,
}).passthrough();

const MAX_SAFE_TIMEOUT_HOURS = Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000);
const REDACTED_TEMPLATE_ID = '[redacted]';

type ValidTemplate = z.infer<typeof TemplateSchema>;

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

function normalizeTemplate(template: ValidTemplate): AiosTemplateCatalogEntry | undefined {
  const names = trimmedUniqueStrings(template.names);
  if (!names.length || template.aios.defaultTimeoutHours > MAX_SAFE_TIMEOUT_HOURS) return undefined;

  return {
    templateId: template.templateID,
    name: names[0]!,
    aliases: canonicalStrings(template.aliases),
    description: template.aios.description,
    envType: template.aios.envType,
    runtimeRole: template.aios.runtimeRole,
    image: template.aios.image,
    ...(template.aios.defaultTimeoutHours > 0
      ? { defaultTimeoutMs: template.aios.defaultTimeoutHours * 3_600_000 }
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

    const seenTemplateIds = new Set<string>();
    const templates: AiosTemplateCatalogEntry[] = [];
    body.forEach((value, index) => {
      const parsed = TemplateSchema.safeParse(value);
      if (!parsed.success) {
        warnIgnoredTemplate(index, value, 'schema');
        return;
      }
      if (parsed.data.buildStatus !== 'ready') {
        warnIgnoredTemplate(index, value, 'build_status');
        return;
      }
      const normalized = normalizeTemplate(parsed.data);
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
    });

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
