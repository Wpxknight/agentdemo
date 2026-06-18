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
  /** 沙箱后端：e2b（默认）或 opensandbox（阿里开源，k8s 运行时）。 */
  provider: z.enum(['e2b', 'opensandbox']).default('e2b'),
  /** API key；E2B 为 ${E2B_API_KEY}，OpenSandbox 为 Lifecycle API key（可空）。 */
  apiKey: z.string().optional(),
  /** 网关域名：E2B 自托管网关 / OpenSandbox Lifecycle API（host[:port]，无 scheme）。 */
  domain: z.string().optional(),
  /** OpenSandbox：http / https。 */
  protocol: z.enum(['http', 'https']).optional(),
  /** OpenSandbox：未指定 template 时的默认镜像。 */
  defaultImage: z.string().optional(),
  /** 空闲回收(ms)。 */
  idleMs: z.number().int().positive().optional(),
  /** 沙箱存活超时(ms)。 */
  timeoutMs: z.number().int().positive().optional(),
  /** 启用远端桌面 / 浏览器工具（@e2b/desktop）。 */
  desktop: z.boolean().default(false),
  /** 预热池大小（>0 时启用；仅未配置集群时生效，避免与集群专用模板冲突）。 */
  warmPoolSize: z.number().int().positive().optional(),
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

const RoleEnum = z.enum(['platform_admin', 'tenant_admin', 'user']);

export const OidcMappingSchema = z.object({
  /** 提供 tenantId 的 claim 名；缺省用 defaultTenant。 */
  tenantClaim: z.string().optional(),
  defaultTenant: z.string().optional(),
  /** 用户名 claim，默认 preferred_username。 */
  usernameClaim: z.string().default('preferred_username'),
  /** 角色/组 claim 名（值可为 string 或 string[]）。 */
  roleClaim: z.string().optional(),
  /** IdP 角色/组 → 本系统角色映射。 */
  roleMap: z.record(z.string(), RoleEnum).optional(),
  defaultRole: RoleEnum.default('user'),
});

export const OidcConfigSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  redirectUri: z.string(),
  scopes: z.array(z.string()).optional(),
  mapping: OidcMappingSchema,
});

export const AuthConfigSchema = z.object({
  provider: z.enum(['local', 'oidc']).default('local'),
  /** 会话 token 有效期（jose 时间串），默认 12h。 */
  jwtTtl: z.string().optional(),
  oidc: OidcConfigSchema.optional(),
});

export const ConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema),
  defaultModel: z.string(),
  skills: z.object({ dir: z.string() }).optional(),
  auth: AuthConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  clusters: z.record(z.string(), ClusterSchema).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
