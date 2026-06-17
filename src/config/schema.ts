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
  /** 该集群对应的 E2B 控制面端点（集群内动态拉起沙箱）。 */
  e2bControl: z.string().optional(),
  /** in-cluster 沙箱模板（含 kubectl + 绑定 ServiceAccount）。 */
  template: z.string().optional(),
  namespace: z.string().optional(),
  serviceAccount: z.string().optional(),
  /** ro=只读拦截一切变更；rw=允许变更（仍受危险命令/审批约束）。 */
  access: z.enum(['ro', 'rw']).default('ro'),
  allowNamespaces: z.array(z.string()).optional(),
  /** 生产集群：变更类操作需审批。 */
  production: z.boolean().default(false),
  /** 集群 ACL：允许访问的租户 id 列表；缺省/空表示所有租户可访问。 */
  tenants: z.array(z.string()).optional(),
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
