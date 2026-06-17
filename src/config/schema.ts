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
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  clusters: z.record(z.string(), ClusterSchema).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
