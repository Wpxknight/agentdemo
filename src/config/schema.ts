import { z } from 'zod';

export const ModelConfigSchema = z.object({
  protocol: z.enum(['anthropic', 'openai']),
  baseURL: z.string(),
  apiKey: z.string(),
  model: z.string(),
});

export const McpServerSchema = z.object({
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** E2B API key；可用 ${E2B_API_KEY} 注入。 */
  apiKey: z.string().optional(),
  /** 自托管 E2B 网关域名。 */
  domain: z.string().optional(),
  /** 空闲回收(ms)。 */
  idleMs: z.number().int().positive().optional(),
  /** 沙箱存活超时(ms)。 */
  timeoutMs: z.number().int().positive().optional(),
});

export const ClusterSchema = z.object({
  e2bControl: z.string(),
  template: z.string(),
  namespace: z.string(),
  serviceAccount: z.string(),
  access: z.enum(['ro', 'rw']),
  allowNamespaces: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema),
  defaultModel: z.string(),
  skills: z.object({ dir: z.string() }).optional(),
  sandbox: SandboxConfigSchema.optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  clusters: z.record(z.string(), ClusterSchema).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
