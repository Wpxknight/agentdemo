import type { NavItem, PageMeta, RuntimeModelConfig, SandboxSummary, ScheduledTask, SessionSummary, ToolSummary } from './types';

export const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: '聊天', icon: 'chat' },
  { id: 'runs', label: '运行中心', icon: 'runs' },
  { id: 'skills', label: '技能', icon: 'skills' },
  { id: 'mcp', label: 'MCP', icon: 'mcp' },
  { id: 'schedule', label: '定时任务', icon: 'schedule' },
  { id: 'sandbox', label: '沙箱环境', icon: 'sandbox' },
  { id: 'users', label: '用户管理', icon: 'users', adminOnly: true },
  { id: 'settings', label: '设置', icon: 'settings' },
];

export const PAGES: Record<string, PageMeta> = {
  chat: { title: 'AI 助手', hasSandboxWorkspace: true, hasSessionHistoryDrawer: true },
  runs: { title: '运行中心', hasSandboxWorkspace: false },
  skills: { title: '技能', hasSandboxWorkspace: false },
  mcp: { title: 'MCP', hasSandboxWorkspace: false },
  schedule: { title: '定时任务', hasSandboxWorkspace: false },
  sandbox: { title: '沙箱环境', hasSandboxWorkspace: false },
  users: { title: '用户管理', hasSandboxWorkspace: false },
  settings: { title: '设置', hasSandboxWorkspace: false },
};

export const fallbackSessions: SessionSummary[] = [
  { title: '检查 Pod 异常', time: '17:31', desc: 'prod 命名空间 aiop-server 异常 Pod' },
  { title: '生成巡检任务', time: '16:48', desc: '创建每日巡检任务' },
  { title: '分析告警', time: '15:22', desc: '最近 2 小时告警趋势' },
  { title: '优化资源配置', time: '昨天', desc: '调整 Deployment 资源限制' },
];

export const fallbackTools: ToolSummary[] = [
  { name: 'inspect', description: '集群与资源巡检', category: 'skill', source: '本地', status: '已启用', lastUsed: '2 分钟前', files: ['SKILL.md', 'main.py', 'schema.yaml'] },
  { name: 'kubectl-ops', description: '封装 kubectl 常用操作', category: 'skill', source: '本地', status: '已启用', lastUsed: '10 分钟前', files: ['SKILL.md', 'kubectl.ts'] },
  { name: 'mcp__filesystem__read_file', description: '读取文件', category: 'mcp', transport: 'stdio', status: '已连接' },
  { name: 'mcp__kubernetes__get_pods', description: '查询 Pod', category: 'mcp', transport: 'stdio', status: '已连接' },
];

export const fallbackTasks: ScheduledTask[] = [
  { task: '每日巡检 aiop 命名空间', cron: '0 2 * * *', nextRunAt: '2026-06-23T02:00:00+08:00', enabled: true, lastRunAt: '2026-06-22T02:00:09+08:00' },
  { task: '每小时检查生产重启次数', cron: '0 * * * *', nextRunAt: '2026-06-22T12:00:00+08:00', enabled: true, lastRunAt: '2026-06-22T11:00:08+08:00' },
  { task: '周报：审计与用量汇总', cron: '0 9 * * 1', nextRunAt: '2026-06-29T09:00:00+08:00', enabled: false, preApproved: false },
];

export const fallbackSandboxes: SandboxSummary[] = [
  { id: 'sandbox-prod', status: 'ready', type: 'session', resources: { cpu: '2 Core', memory: '4 Gi', storage: '50 Gi' }, sessionId: '#8124', createdAt: '2026-06-22T10:15:00+08:00', actions: ['打开终端', '打开浏览器预览'] },
  { id: 'sandbox-browser', status: 'starting', type: 'browser', resources: { cpu: '1 Core', memory: '2 Gi', storage: '20 Gi' }, sessionId: '未绑定', createdAt: '2026-06-22T09:02:00+08:00', actions: ['打开浏览器'] },
];

export const defaultLlmConfig: RuntimeModelConfig = {
  id: 'glm-5',
  protocol: 'anthropic',
  base_url: 'http://192.168.10.108:18317',
  model: 'glm-5',
  api_key: '',
  api_key_set: false,
  api_key_preview: '',
  context_window_tokens: 200000,
  options: [],
};
