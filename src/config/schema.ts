import { z } from 'zod';

export const ModelConfigSchema = z.object({
  protocol: z.enum(['anthropic', 'openai']),
  baseURL: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /** 推理深度：none 关闭思考；low..max 对应 Anthropic effort；缺省=思考开启走模型默认深度。 */
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export const McpServerSchema = z.object({
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SandboxProfileSchema = z.object({
  /** 展示给模型和 UI 的用途说明。 */
  description: z.string().optional(),
  /** OpenSandbox image / E2B template。 */
  image: z.string().optional(),
  /** 兼容既有 SandboxSpec.template 命名。 */
  template: z.string().optional(),
  /** 指向独立 OpenSandbox/E2B 控制面，用于隔离普通/运维沙箱。 */
  domain: z.string().optional(),
  namespace: z.string().optional(),
  serviceAccount: z.string().optional(),
  /** 该 profile 是否适合作为浏览器/桌面沙箱。 */
  desktop: z.boolean().optional(),
  /** 仅用于展示和提示；真正权限边界由 OpenSandbox server PodTemplate/RBAC 决定。 */
  privileged: z.boolean().default(false),
  /** 供模型选择 profile 时参考的能力标签。 */
  capabilities: z.array(z.string()).default([]),
  /** 注入沙箱的环境变量。不要放敏感值；UI/API 不回显 env。 */
  envs: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 沙箱后端：local（本地开发）、e2b 或 opensandbox（阿里开源，k8s 运行时）。 */
  provider: z.enum(['local', 'e2b', 'opensandbox']).default('e2b'),
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
  /** 启用桌面 / 浏览器工具；opensandbox 在同一会话 Pod 内启动 Chrome。 */
  desktop: z.boolean().default(false),
  /** 预热池大小（>0 时启用；仅未配置集群时生效，避免与集群专用模板冲突）。 */
  warmPoolSize: z.number().int().positive().optional(),
  /** 可供模型选择的沙箱模板列表。缺省时自动生成 default profile。 */
  profiles: z.record(z.string(), SandboxProfileSchema).optional(),
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

export const BootstrapAdminSchema = z.object({
  tenantId: z.string().default('default'),
  username: z.string(),
  password: z.string(),
  role: RoleEnum.default('platform_admin'),
});

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
  /** 仅用于 dev/test IdP；生产必须使用 HTTPS issuer。 */
  allowInsecureHttp: z.boolean().default(false),
  mapping: OidcMappingSchema,
});

export const AuthConfigSchema = z.object({
  provider: z.enum(['local', 'oidc']).default('local'),
  /** 会话 token 有效期（jose 时间串），默认 12h。 */
  jwtTtl: z.string().optional(),
  /** 本地开发/部署引导管理员；仅 local 认证模式生效，已存在则跳过。 */
  bootstrapAdmin: BootstrapAdminSchema.optional(),
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
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
