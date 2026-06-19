export const NAV_ITEMS = [
  { id: 'chat', label: '聊天', icon: 'msg' },
  { id: 'skills', label: '技能', icon: 'box' },
  { id: 'mcp', label: 'MCP', icon: 'link' },
  { id: 'schedule', label: '定时任务', icon: 'cal' },
  { id: 'sandbox', label: '沙箱环境', icon: 'cube' },
  { id: 'settings', label: '设置', icon: 'gear' },
];

export const PAGES = {
  chat: { title: 'AI 助手', hasSandboxWorkspace: true, hasSessionHistoryDrawer: true },
  skills: { title: '技能', hasSandboxWorkspace: false },
  mcp: { title: 'MCP', hasSandboxWorkspace: false },
  schedule: { title: '定时任务', hasSandboxWorkspace: false },
  sandbox: { title: '沙箱环境', hasSandboxWorkspace: false },
  settings: { title: '设置', hasSandboxWorkspace: false },
};

const fallbackSessions = [
  { title: '检查 Pod 异常', time: '17:31', desc: '帮我检查 prod 命名空间下 aiop-server 的异常 Pod' },
  { title: '生成巡检任务', time: '16:48', desc: '为 prod 集群创建每日巡检任务' },
  { title: '分析告警', time: '15:22', desc: '分析最近 2 小时的告警趋势' },
  { title: '优化资源配置', time: '昨天', desc: '建议调整 Deployment 资源限制' },
];

const fallbackTools = [
  { name: 'inspect', description: '集群与资源巡检，支持获取集群健康、节点与资源信息', category: 'skill', source: '本地', status: '已启用', lastUsed: '2 分钟前', files: ['SKILL.md', 'main.py', 'schema.yaml', 'utils.py'] },
  { name: 'kubectl-ops', description: '封装 kubectl 常用操作，支持查询、变更与诊断', category: 'skill', source: '本地', status: '已启用', lastUsed: '10 分钟前', files: ['SKILL.md', 'kubectl.ts', 'policy.yaml'] },
  { name: 'browser-use', description: '浏览器自动化操作与信息收集，支持表单填写、截屏等', category: 'skill', source: '本地', status: '已启用', lastUsed: '1 小时前', files: ['SKILL.md', 'browser.ts'] },
  { name: 'pdf-extract', description: '解析 PDF 文件并提取文本内容，支持多页与表格识别', category: 'skill', source: '本地', status: '已启用', lastUsed: '3 小时前', files: ['SKILL.md', 'schema.yaml'] },
  { name: 'mcp__filesystem__read_file', description: '读取文件', category: 'mcp', transport: 'stdio', status: '已连接' },
  { name: 'mcp__filesystem__write_file', description: '写入文件', category: 'mcp', transport: 'stdio', status: '已连接' },
  { name: 'mcp__kubernetes__get_pods', description: '查询 Pod', category: 'mcp', transport: 'stdio', status: '已连接' },
  { name: 'mcp__browser__snapshot', description: '浏览器截图', category: 'mcp', transport: 'sse', status: '异常' },
];

const fallbackTasks = [
  { task: '每日巡检 aiop 命名空间', cron: '0 2 * * *', nextRunAt: '2024-05-27T02:00:00+08:00', enabled: true, lastRunAt: '2024-05-26T02:00:09+08:00' },
  { task: '每小时检查生产重启次数', cron: '0 * * * *', nextRunAt: '2024-05-26T17:00:00+08:00', enabled: true, lastRunAt: '2024-05-26T16:00:08+08:00' },
  { task: '周报：审计与用量汇总', cron: '0 9 * * 1', nextRunAt: '2024-05-27T09:00:00+08:00', enabled: false, preApproved: false },
  { task: '安全漏洞扫描', cron: '0 1 * * *', nextRunAt: '2024-05-27T01:00:00+08:00', enabled: true, lastRunAt: '2024-05-26T01:00:11+08:00' },
];

const fallbackSandboxes = [
  { id: 'sandbox-prod', status: 'ready', type: 'k8s', resources: { cpu: '2 Core', memory: '4 Gi', storage: '50 Gi' }, sessionId: '#8124', createdAt: '2024-05-26T10:15:00+08:00', actions: ['打开终端', '打开 VNC', '打开浏览器'] },
  { id: 'sandbox-dev', status: 'idle', type: 'k8s', resources: { cpu: '2 Core', memory: '4 Gi', storage: '50 Gi' }, sessionId: '#8001', createdAt: '2024-05-25T16:30:00+08:00', actions: ['打开终端', '打开 VNC'] },
  { id: 'sandbox-browser', status: 'starting', type: 'browser', resources: { cpu: '1 Core', memory: '2 Gi', storage: '20 Gi' }, sessionId: '未绑定', createdAt: '2024-05-26T09:02:00+08:00', actions: ['打开浏览器'] },
];

const defaultLlmConfig = {
  id: 'glm-5',
  protocol: 'anthropic',
  base_url: 'http://192.168.10.108:18317',
  model: 'glm-5',
  api_key_set: false,
  api_key_preview: '',
};

const state = {
  page: 'chat',
  historyOpen: true,
  sandboxOpen: true,
  token: readStorage('aiop_token') || '',
  sessionId: readStorage('aiop_session_id') || randomId(),
  sessions: fallbackSessions,
  tools: [],
  tasks: [],
  sandboxes: [],
  llm: defaultLlmConfig,
  hiddenNavTip: '',
  settingsStatus: '',
  sandboxOutput: '沙箱输出会显示在这里。',
  browserUrl: 'https://example.com',
  browserStreamUrl: '',
  attachments: [],
  toolTestOutput: '',
  messages: [
    {
      role: 'assistant',
      text: '你好，我是你的 AI 运维助手。\n\n我可以帮你查询集群状态、分析告警、执行变更、管理配置、排查问题等。',
      time: '10:15:23',
    },
    {
      role: 'user',
      text: '帮我检查 prod 命名空间下 aiop-server 的 Pod 异常，并给出修复建议。',
      time: '10:16:03',
    },
    {
      role: 'assistant',
      text: '已发现 aiop-server-6d9c 重启 5 次，最近一次原因是 OOMKilled。\n\n建议先查看资源限制，必要时调整内存并重启 Pod。',
      time: '10:16:08',
      tools: ['kubectl get pods', 'kubectl describe pod', '分析影响', '生成修复建议'],
    },
  ],
};
writeStorage('aiop_session_id', state.sessionId);

function readStorage(key) {
  return typeof localStorage === 'undefined' ? '' : localStorage.getItem(key);
}

function writeStorage(key, value) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function apiGet(path) {
  if (!state.token) return undefined;
  const response = await fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
  if (response.status === 401) {
    state.token = '';
    writeStorage('aiop_token', '');
    return undefined;
  }
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function apiPost(path, body = {}) {
  if (!state.token) return undefined;
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    state.token = '';
    writeStorage('aiop_token', '');
    return undefined;
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `${path} failed: ${response.status}`);
  }
  return response.json();
}

async function loadLlmSettings() {
  const body = await apiGet('/v1/settings/llm');
  if (body?.config) state.llm = { ...state.llm, ...body.config };
}

async function loadPageData(page = state.page) {
  if (!state.token) return;
  try {
    if (page === 'chat') {
      const body = await apiGet('/v1/sessions?limit=20');
      state.sessions = body?.sessions?.map((session) => ({
        title: session.title || session.sessionId,
        time: formatTime(session.updatedAt),
        desc: session.lastMessage || `${session.messageCount ?? 0} 条消息`,
        sessionId: session.sessionId,
      })) || fallbackSessions;
    }
    if (page === 'skills' || page === 'mcp') {
      const body = await apiGet('/v1/tools');
      state.tools = body?.tools || [];
    }
    if (page === 'schedule') {
      const body = await apiGet('/v1/schedule');
      state.tasks = body?.tasks || [];
    }
    if (page === 'sandbox') {
      const body = await apiGet('/v1/sandboxes');
      state.sandboxes = body?.sandboxes || [];
    }
    if (page === 'settings') {
      await loadLlmSettings();
    }
    render();
  } catch (err) {
    console.error(err);
  }
}

function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toolsForCategory(category) {
  const loaded = state.tools.filter((tool) => tool.category === category);
  if (loaded.length) return loaded;
  return fallbackTools.filter((tool) => tool.category === category);
}

function toolDisplayName(name) {
  return String(name || '').replace(/^mcp__[^_]+__/, '').replace(/^skill__/, '') || '-';
}

function mcpServerName(name) {
  const parts = String(name || '').split('__');
  return parts[0] === 'mcp' && parts[1] ? parts[1] : toolDisplayName(name);
}

function buildMcpServers(tools) {
  const servers = new Map();
  for (const tool of tools) {
    const name = mcpServerName(tool.name);
    const server = servers.get(name) || {
      name,
      transport: tool.transport || 'stdio',
      status: tool.status || '已连接',
      tools: [],
    };
    server.tools.push(tool);
    servers.set(name, server);
  }
  return [...servers.values()];
}

function humanizeCron(cron) {
  const map = {
    '0 2 * * *': '每天 02:00',
    '0 1 * * *': '每天 01:00',
    '0 * * * *': '每小时',
    '0 9 * * 1': '每周一 09:00',
  };
  return map[cron] || cron || '-';
}

function resourceSummary(resources = {}) {
  if (!resources || typeof resources !== 'object') return '-';
  return [resources.cpu, resources.memory, resources.storage].filter(Boolean).join(' / ') || '-';
}

function iconSvg(name) {
  const icons = {
    msg: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    box: '<path d="m21 16-9 5-9-5V8l9-5 9 5z"/><path d="M3.5 8.5 12 13l8.5-4.5"/><path d="M12 22V13"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    cal: '<path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/>',
    cube: '<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="m3.3 7.7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    close: '<path d="m15 18-6-6 6-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z"/>',
    panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m14 10-2 2 2 2"/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m10 10 2 2-2 2"/>',
    attach: '<path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
    text: '<path d="M4 7V5h16v2"/><path d="M9 20h6"/><path d="M12 5v15"/>',
    screen: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8"/><path d="M12 18v4"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.box}</svg>`;
}

function pageShell(content, options = {}) {
  const page = PAGES[state.page];
  const contentClass = options.wide ? 'content content-wide' : 'content';
  return `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main">
        ${renderTopbar()}
        <section class="${contentClass}">
          ${content}
        </section>
      </main>
    </div>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar" aria-label="主导航">
      <div class="brand" title="AIOP">
        <span class="brand-mark">${iconSvg('cube')}</span>
      </div>
      <nav class="nav-rail">
        ${NAV_ITEMS.map((item) => {
          const navClass = [
            'nav-btn',
            state.page === item.id ? 'active' : '',
            state.hiddenNavTip === item.id ? 'hide-tip' : '',
          ].filter(Boolean).join(' ');
          return `
            <button class="${navClass}" data-nav="${item.id}" aria-label="${item.label}">
              ${iconSvg(item.icon)}
              <span class="nav-tip">${item.label}</span>
            </button>
          `;
        }).join('')}
      </nav>
    </aside>
  `;
}

function renderTopbar() {
  return `
    <header class="topbar">
      <div class="top-left">
        <div class="logo-text">AIOP</div>
        <button class="select-chip" data-nav="settings">模型 <strong>${escapeHtml(state.llm.model || '未配置')}</strong></button>
      </div>
      <div class="top-right">
        <button class="select-chip">租户 <strong>default</strong></button>
        <button class="icon-button" title="帮助">?</button>
        <button class="user-chip">${state.token ? 'platform_admin' : '未登录'}</button>
      </div>
    </header>
  `;
}

function renderChatPage() {
  const layoutClass = [
    'chat-layout',
    state.historyOpen ? '' : 'history-closed',
    state.sandboxOpen ? '' : 'sandbox-closed',
  ].filter(Boolean).join(' ');
  return pageShell(`
    <div class="${layoutClass}">
      ${state.historyOpen ? renderSessionHistory() : ''}
      <section class="chat-panel">
        <div class="panel-header">
          <div>
            <h1>AI 助手</h1>
            <p>有什么可以帮你？</p>
          </div>
          <div class="header-actions">
            <span class="status-pill">运行中</span>
            <button class="icon-button" data-action="toggle-history" title="${state.historyOpen ? '收起会话' : '展开会话'}">${iconSvg('panelLeft')}</button>
            <button class="icon-button" data-action="toggle-sandbox" title="${state.sandboxOpen ? '收起沙箱' : '展开沙箱'}">${iconSvg('panelRight')}</button>
            <button class="ghost-btn" data-action="login">登录</button>
            <button class="primary-btn" data-action="new-session">新建会话</button>
          </div>
        </div>
        <div class="messages" id="messages">
          ${state.messages.map(renderMessage).join('')}
        </div>
        <form class="composer" id="composer">
          <input id="attachment-input" type="file" multiple hidden />
          ${state.attachments.length ? `<div class="attachment-list composer-attachments">${renderAttachmentChips(state.attachments, true)}</div>` : ''}
          <div class="composer-main">
            <div class="composer-tools">
              <button class="icon-button" type="button" data-action="choose-attachment" title="添加附件">${iconSvg('attach')}</button>
              <span class="tool-token">{ }</span>
              <span class="tool-token">${iconSvg('terminal')}</span>
            </div>
            <textarea name="task" rows="2" placeholder="输入你的运维问题或指令，Enter 发送，Shift/Alt+Enter 换行..."></textarea>
            <button class="primary-btn send-btn" type="submit">${iconSvg('send')}发送</button>
          </div>
        </form>
      </section>
      ${state.sandboxOpen ? renderSandboxWorkspace() : ''}
    </div>
  `);
}

function renderSessionHistory() {
  const visibleSessions = state.sessions.length ? state.sessions : fallbackSessions;
  const todaySessions = visibleSessions.slice(0, 3);
  const olderSessions = visibleSessions.slice(3, 4);
  return `
    <aside class="session-drawer">
      <div class="drawer-head">
        <h2>最近会话</h2>
        <button class="icon-button" data-action="toggle-history" title="收起">${iconSvg('close')}</button>
      </div>
      <label class="search-box">${iconSvg('search')}<input placeholder="搜索会话" /></label>
      <div class="session-group">今天</div>
      ${todaySessions.map((s, i) => `
        <button class="session-row ${i === 0 ? 'active' : ''}">
          <strong>${s.title}</strong><time>${s.time}</time><span>${s.desc}</span>
        </button>
      `).join('')}
      ${olderSessions.length ? `<div class="session-group">昨天</div>${olderSessions.map((s) => `
        <button class="session-row"><strong>${s.title}</strong><time>${s.time}</time><span>${s.desc}</span></button>
      `).join('')}` : ''}
    </aside>
  `;
}

function formatFileSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachmentChips(attachments, removable = false) {
  return attachments.map((file) => `
    <span class="attachment-chip" title="${escapeAttr(file.name)}">
      ${iconSvg('attach')}
      <span>${escapeHtml(file.name)}</span>
      <small>${escapeHtml(file.type || 'file')} · ${formatFileSize(file.size)}</small>
      ${removable ? `<button type="button" class="attachment-remove" data-action="remove-attachment" data-attachment-id="${escapeAttr(file.id)}" title="移除附件">${iconSvg('trash')}</button>` : ''}
    </span>
  `).join('');
}

function renderMessage(msg) {
  const isUser = msg.role === 'user';
  const text = String(msg.text || '');
  return `
    <article class="message ${isUser ? 'message-user' : 'message-assistant'}">
      <div class="avatar">${isUser ? '人' : 'AI'}</div>
      <div class="bubble">
        ${text.split('\n').map((line) => line ? `<p>${escapeHtml(line)}</p>` : '<br />').join('')}
        ${msg.attachments?.length ? `<div class="attachment-list">${renderAttachmentChips(msg.attachments)}</div>` : ''}
        ${msg.tools ? `<div class="tool-chips">${msg.tools.map((tool) => `<span>${tool}</span>`).join('')}</div>` : ''}
        <time>${msg.time}</time>
      </div>
    </article>
  `;
}

function renderSandboxWorkspace() {
  const outputLines = String(state.sandboxOutput || '').split('\n');
  return `
    <aside class="sandbox-panel">
      <div class="sandbox-head">
        <h2>当前沙箱</h2>
        <button class="ghost-btn" data-action="toggle-sandbox">收起</button>
        <span class="ready-dot"></span><span>sandbox-prod · ready</span>
      </div>
      <div class="tabs"><button class="active">终端</button><button>VNC</button><button>浏览器</button></div>
      <section class="sandbox-tool">
        <div class="tool-title"><strong>运行代码</strong><select name="language" form="sandbox-code-form"><option value="python">Python</option><option value="javascript">JavaScript</option><option value="bash">Bash</option></select></div>
        <form id="sandbox-code-form" class="sandbox-form">
          <textarea name="code" rows="4" spellcheck="false">print("hello from sandbox")</textarea>
          <button class="primary-btn" type="button" data-action="run-sandbox-code">运行代码</button>
        </form>
      </section>
      <section class="sandbox-tool">
        <div class="tool-title">
          <strong>操作浏览器</strong>
          <div class="tool-actions">
            <button class="ghost-btn" type="button" data-action="browser-stream">${iconSvg('screen')}VNC</button>
            <button class="ghost-btn" type="button" data-action="browser-screenshot">截图</button>
          </div>
        </div>
        <form id="browser-control-form" class="browser-form">
          <input name="url" value="${escapeAttr(state.browserUrl)}" placeholder="https://example.com" />
          <button class="primary-btn" type="button" data-action="browser-navigate">打开 URL</button>
          <label><span>X</span><input name="x" value="160" inputmode="numeric" /></label>
          <label><span>Y</span><input name="y" value="160" inputmode="numeric" /></label>
          <button class="ghost-btn" type="button" data-action="browser-click">${iconSvg('mouse')}点击</button>
          <input name="text" placeholder="输入要键入的文本" />
          <button class="ghost-btn" type="button" data-action="browser-type">${iconSvg('text')}输入</button>
        </form>
      </section>
      <div class="terminal">
        ${outputLines.map((line) => `<div>${escapeHtml(line) || '&nbsp;'}</div>`).join('')}
      </div>
      <div class="vnc-preview">
        ${state.browserStreamUrl
          ? `<iframe id="vnc-preview-frame" class="vnc-preview-frame" src="${escapeAttr(state.browserStreamUrl)}" title="VNC / Browser stream"></iframe>`
          : `<div class="browser-bar"></div>
            <div class="desktop">
              <div class="desktop-sidebar"></div>
              <div class="desktop-window">
                <strong>Kubernetes Dashboard</strong>
                <div class="mini-table"><span>aiop-server</span><span class="bad">0/1</span><span>5</span></div>
                <div class="mini-table"><span>aiop-worker</span><span class="good">1/1</span><span>0</span></div>
              </div>
            </div>`}
      </div>
      <div class="sandbox-actions">
        <button class="ghost-btn" type="button" data-action="browser-stream">进入全屏</button>
        <button class="ghost-btn">复制连接</button>
      </div>
    </aside>
  `;
}

function renderSkillsPage() {
  const skillRows = toolsForCategory('skill');
  const selected = skillRows[0] || fallbackTools.find((tool) => tool.category === 'skill');
  const selectedTool = selected?.name || 'load_skill';
  const defaultArgs = selectedTool === 'load_skill' ? { name: 'inspect' } : {};
  return pageShell(managementHeader('技能', '管理和配置 AI 助手可调用的技能，提升运维自动化能力', '搜索技能', '导入技能') + `
    <div class="two-pane">
      <section class="list-card">
        ${renderRows(skillRows.map((tool) => [
          toolDisplayName(tool.name),
          tool.description || '-',
          tool.source || '后端',
          tool.status || '已启用',
          tool.lastUsed || '-',
        ]), ['技能名称', '描述', '来源', '状态', '最近使用'])}
      </section>
      <aside class="detail-card">
        <div class="detail-title"><div class="large-icon">${iconSvg('search')}</div><div><h2>${escapeHtml(toolDisplayName(selected?.name))}</h2><span class="status-pill">${escapeHtml(selected?.status || '已启用')}</span></div><label class="switch"><input type="checkbox" checked /><span></span></label></div>
        <h3>描述</h3><p>${escapeHtml(selected?.description || '后端已注册的 AI 助手能力。')}</p>
        <h3>Frontmatter</h3><pre class="code-block">name: inspect
description: ${escapeHtml(selected?.description || 'AI 助手能力')}
version: 1.0.0</pre>
        <h3>引用文件</h3><div class="file-list">${(selected?.files || ['SKILL.md', 'schema.json']).map((file) => `<span>${escapeHtml(file)}</span>`).join('')}</div>
        <h3>测试加载</h3>
        <form id="skill-test-form" class="tool-test-form">
          <input type="hidden" name="tool" value="${escapeAttr(selectedTool)}" />
          <textarea id="tool-test-args" name="args" rows="5" spellcheck="false">${escapeHtml(JSON.stringify(defaultArgs, null, 2))}</textarea>
          <button class="primary-btn" type="button" data-action="test-skill">测试加载</button>
        </form>
        ${state.toolTestOutput ? `<pre class="tool-output">${escapeHtml(state.toolTestOutput)}</pre>` : ''}
        <div class="bottom-actions"><button class="ghost-btn">查看 SKILL.md</button></div>
      </aside>
    </div>
  `, { wide: true });
}

function renderMcpPage() {
  const mcpRows = toolsForCategory('mcp');
  const servers = buildMcpServers(mcpRows);
  const selected = servers[0] || { name: '-', transport: '-', status: '未连接', tools: [] };
  return pageShell(managementHeader('MCP', '管理和配置 MCP server，扩展 AI 助手的能力边界', '搜索 MCP server', '新增 MCP') + `
    <div class="two-pane">
      <section class="list-card">
        ${renderRows(servers.map((server) => [
          server.name,
          server.transport,
          server.status,
          String(server.tools.length),
          formatTime(new Date().toISOString()),
        ]), ['名称', '传输协议', '状态', '工具数', '最近心跳'])}
      </section>
      <aside class="detail-card">
        <div class="detail-title"><div class="large-icon">${iconSvg('box')}</div><div><h2>${escapeHtml(selected.name)}</h2><span class="status-pill">${escapeHtml(selected.status)}</span></div><label class="switch"><input type="checkbox" checked /><span></span></label></div>
        <h3>连接配置</h3><div class="kv"><span>传输协议</span><strong>${escapeHtml(selected.transport)}</strong><span>命令</span><strong>registry</strong><span>工作目录</span><strong>/mcp/servers/${escapeHtml(selected.name)}</strong></div>
        <h3>工具列表（${selected.tools.length}）</h3><div class="tool-grid">${selected.tools.map((tool) => `<span>${escapeHtml(toolDisplayName(tool.name))}</span>`).join('')}</div>
        <h3>测试调用</h3>
        <form id="mcp-test-form" class="tool-test-form">
          <select name="tool">${selected.tools.map((tool) => `<option value="${escapeAttr(tool.name)}">${escapeHtml(toolDisplayName(tool.name))}</option>`).join('')}</select>
          <textarea id="tool-test-args" name="args" rows="5" spellcheck="false">{}</textarea>
          <button class="primary-btn" type="button" data-action="test-mcp">测试工具</button>
        </form>
        ${state.toolTestOutput ? `<pre class="tool-output">${escapeHtml(state.toolTestOutput)}</pre>` : ''}
        <div class="bottom-actions"><button class="ghost-btn">重新连接</button><button class="danger-btn">禁用</button></div>
      </aside>
    </div>
  `, { wide: true });
}

function renderSchedulePage() {
  const taskRows = state.tasks.length ? state.tasks : fallbackTasks;
  const selected = taskRows[0] || fallbackTasks[0];
  return pageShell(`
    <div class="page-title"><h1>定时任务</h1><p>配置和管理定时执行的 AI 任务</p></div>
    <section class="create-task">
      <label><span>创建任务</span><textarea placeholder="描述你要定时执行的任务，支持自然语言和命令..."></textarea></label>
      <label><span>执行计划（Cron）</span><input value="每天 02:00" /></label>
      <label class="approval"><span>需要审批</span><label class="switch"><input type="checkbox" /><span></span></label></label>
      <button class="primary-btn">创建任务</button>
    </section>
    <div class="task-layout">
      <section class="list-card">
        ${renderRows(taskRows.map((task) => [
          task.task,
          humanizeCron(task.cron),
          formatDateTime(task.nextRunAt),
          task.enabled ? '启用' : '暂停',
          task.lastRunAt ? '成功' : (task.preApproved ? '已预批准' : '待执行'),
        ]), ['任务', '计划', '下次执行', '状态', '最近结果'])}
      </section>
      <aside class="detail-card compact">
        <h2>${escapeHtml(selected.task)}</h2>
        <p>会话 ${escapeHtml(selected.sessionId || '-')} · ${escapeHtml(humanizeCron(selected.cron))} · 下次执行 ${escapeHtml(formatDateTime(selected.nextRunAt))}</p>
        <h3>最近运行（最近 3 次）</h3>
        ${renderRows([
          [formatDateTime(selected.lastRunAt), selected.lastRunAt ? '成功' : '待执行', selected.lastRunAt ? '18.42s' : '-'],
          ['-', '待执行', '-'],
          ['-', '待执行', '-'],
        ], ['时间', '状态', '耗时'])}
        <div class="bottom-actions"><button class="primary-btn">立即执行</button><button class="ghost-btn">暂停</button><button class="ghost-btn">编辑</button></div>
      </aside>
    </div>
  `, { wide: true });
}

function renderSandboxPage() {
  const sandboxRows = state.sandboxes.length ? state.sandboxes : fallbackSandboxes;
  const selected = sandboxRows[0] || fallbackSandboxes[0];
  return pageShell(`
    <div class="page-title"><h1>沙箱环境</h1><p>管理和使用隔离的沙箱环境，安全执行运维操作</p></div>
    <div class="toolbar"><button class="select-chip"><span class="ready-dot"></span>运行中</button><label class="search-box">${iconSvg('search')}<input placeholder="搜索沙箱" /></label><button class="primary-btn">新建沙箱</button></div>
    <div class="two-pane">
      <section class="list-card">
        ${renderRows(sandboxRows.map((sandbox) => [
          sandbox.id,
          sandbox.status,
          sandbox.type || 'session',
          resourceSummary(sandbox.resources),
          sandbox.sessionId || '未绑定',
          formatDateTime(sandbox.createdAt),
        ]), ['名称', '状态', '类型', '资源', '绑定会话', '创建时间'])}
      </section>
      <aside class="detail-card">
        <div class="detail-title"><div class="large-icon">${iconSvg('cube')}</div><div><h2>${escapeHtml(selected.id)}</h2><span class="status-pill">${escapeHtml(selected.status)}</span></div><label class="switch"><input type="checkbox" checked /><span></span></label></div>
        <h3>基本信息</h3><div class="kv"><span>模板</span><strong>${escapeHtml(selected.type || 'session')}</strong><span>资源</span><strong>${escapeHtml(resourceSummary(selected.resources))}</strong><span>创建时间</span><strong>${escapeHtml(formatDateTime(selected.createdAt))}</strong></div>
        <h3>连接信息</h3><div class="file-list"><span>Terminal 127.0.0.1/sandbox/${escapeHtml(selected.id)}/terminal</span><span>VNC 127.0.0.1/sandbox/${escapeHtml(selected.id)}/vnc</span><span>Browser 127.0.0.1/sandbox/${escapeHtml(selected.id)}/browser</span></div>
        <div class="bottom-actions wrap">${(selected.actions || ['打开终端', '打开 VNC', '打开浏览器']).map((action) => `<button class="ghost-btn">${escapeHtml(action)}</button>`).join('')}<button class="ghost-btn">续期</button><button class="danger-btn">销毁</button></div>
      </aside>
    </div>
  `, { wide: true });
}

function renderSettingsPage() {
  const cfg = { ...defaultLlmConfig, ...state.llm };
  const keyHint = cfg.api_key_set ? `已配置：${cfg.api_key_preview}` : '输入 API Key';
  return pageShell(`
    <div class="page-title"><h1>设置</h1><p>配置 AI 助手当前使用的 LLM 服务</p></div>
    <div class="settings-layout">
      <section class="settings-panel">
        <form class="settings-form" id="llm-settings-form">
          <div class="settings-section-title">
            <h2>LLM 配置</h2>
            <span class="status-pill">${escapeHtml(cfg.protocol)}</span>
          </div>
          <label><span>协议</span><select name="protocol">
            <option value="anthropic" ${cfg.protocol === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            <option value="openai" ${cfg.protocol === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
          </select></label>
          <label><span>Base URL</span><input name="base_url" value="${escapeAttr(cfg.base_url)}" placeholder="http://host:port/v1" /></label>
          <label><span>API Key</span><input name="api_key" type="password" placeholder="${escapeAttr(keyHint)}" autocomplete="off" /></label>
          <label><span>Model</span><input name="model" value="${escapeAttr(cfg.model)}" placeholder="glm-5" /></label>
          ${state.settingsStatus ? `<div class="settings-status">${escapeHtml(state.settingsStatus)}</div>` : ''}
          <div class="form-actions">
            <button class="ghost-btn" type="button" data-action="test-llm">测试连接</button>
            <button class="primary-btn" type="submit">保存配置</button>
          </div>
        </form>
      </section>
      <aside class="detail-card settings-summary">
        <div class="detail-title"><div class="large-icon">${iconSvg('gear')}</div><div><h2>${escapeHtml(cfg.model || '未配置')}</h2><span class="status-pill">${cfg.api_key_set ? '密钥已配置' : '密钥未配置'}</span></div></div>
        <h3>当前连接</h3>
        <div class="kv"><span>协议</span><strong>${escapeHtml(cfg.protocol)}</strong><span>Base URL</span><strong>${escapeHtml(cfg.base_url || '-')}</strong><span>Model</span><strong>${escapeHtml(cfg.model || '-')}</strong><span>API Key</span><strong>${escapeHtml(cfg.api_key_preview || '-')}</strong></div>
      </aside>
    </div>
  `, { wide: true });
}

function managementHeader(title, subtitle, placeholder, action) {
  return `
    <div class="page-title"><h1>${title}</h1><p>${subtitle}</p></div>
    <div class="toolbar">
      <label class="search-box">${iconSvg('search')}<input placeholder="${placeholder}" /></label>
      <button class="ghost-btn">全部</button>
      <button class="ghost-btn">已启用</button>
      <button class="ghost-btn">本地</button>
      <button class="primary-btn">${action}</button>
    </div>
  `;
}

function renderRows(rows, headers) {
  return `
    <table class="data-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row, idx) => `<tr class="${idx === 0 ? 'selected' : ''}">${row.map((cell) => `<td>${formatCell(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `;
}

function formatCell(cell) {
  if (['已启用', '已连接', '启用', '成功', 'ready'].includes(cell)) return `<span class="green-dot"></span>${cell}`;
  if (['异常', '待审批', 'starting'].includes(cell)) return `<span class="orange-dot"></span>${cell}`;
  if (['已禁用', '暂停', 'idle'].includes(cell)) return `<span class="muted-dot"></span>${cell}`;
  return escapeHtml(String(cell));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const renderers = {
    chat: renderChatPage,
    skills: renderSkillsPage,
    mcp: renderMcpPage,
    schedule: renderSchedulePage,
    sandbox: renderSandboxPage,
    settings: renderSettingsPage,
  };
  app.innerHTML = renderers[state.page]();
}

async function login() {
  const username = prompt('用户名', 'admin');
  if (!username) return;
  const password = prompt('密码');
  if (!password) return;
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: 'default', username, password }),
  });
  if (!response.ok) {
    alert('登录失败');
    return;
  }
  const body = await response.json();
  state.token = body.token;
  writeStorage('aiop_token', state.token);
  await loadPageData(state.page);
  render();
}

function llmPayload(form) {
  const apiKey = String(form.get('api_key') || '').trim();
  const payload = {
    protocol: String(form.get('protocol') || 'anthropic'),
    base_url: String(form.get('base_url') || '').trim(),
    model: String(form.get('model') || '').trim(),
  };
  if (apiKey) payload.api_key = apiKey;
  return payload;
}

async function ensureLogin() {
  if (state.token) return true;
  await login();
  return Boolean(state.token);
}

async function saveLlmSettings(form) {
  if (!(await ensureLogin())) return;
  state.settingsStatus = '正在保存配置...';
  render();
  try {
    const body = await apiPost('/v1/settings/llm', llmPayload(form));
    if (body?.config) state.llm = { ...state.llm, ...body.config };
    state.settingsStatus = '配置已保存，新的聊天请求会使用该模型。';
  } catch (err) {
    state.settingsStatus = `保存失败：${formatError(err)}`;
  }
  render();
}

async function testLlmSettings(form) {
  if (!(await ensureLogin())) return;
  state.settingsStatus = '正在测试模型连接...';
  render();
  try {
    const body = await apiPost('/v1/settings/llm/test', llmPayload(form));
    state.settingsStatus = `测试成功：${body?.text || '模型已响应'}`;
  } catch (err) {
    state.settingsStatus = `测试失败：${formatError(err)}`;
  }
  render();
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err || '未知错误');
}

function formatToolResponse(body) {
  const result = body?.result;
  const content = result?.content || body?.error || '操作完成。';
  const image = result?.contentBlocks?.find?.((block) => block.type === 'image');
  return image ? `${content}\n[image] ${image.mimeType} ${image.data.length} bytes base64` : content;
}

function extractUrl(text) {
  const value = String(text || '');
  return value.match(/data:text\/html[^ \n)]+/)?.[0]
    || value.match(/https?:\/\/[^\s)]+/)?.[0]
    || value.match(/\/[a-zA-Z0-9_./?=&%-]+/)?.[0]
    || '';
}

function parseToolArgs(raw) {
  const value = String(raw || '').trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('参数 JSON 格式错误');
  }
}

async function callToolFromForm(form) {
  if (!(await ensureLogin())) return;
  const name = String(form.get('tool') || '').trim();
  if (!name) return;
  state.toolTestOutput = '正在调用工具...';
  render();
  try {
    const args = parseToolArgs(form.get('args'));
    const body = await apiPost('/v1/tools/call', { sessionId: state.sessionId, name, args });
    state.toolTestOutput = formatToolResponse(body);
  } catch (err) {
    state.toolTestOutput = `调用失败：${formatError(err)}`;
  }
  render();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

async function addAttachments(fileList) {
  const files = [...(fileList || [])].slice(0, 6);
  if (!files.length) return;
  for (const file of files) {
    const data = await readFileAsDataUrl(file);
    state.attachments.push({
      id: randomId(),
      name: file.name || 'attachment',
      type: file.type || 'application/octet-stream',
      size: file.size || 0,
      data,
    });
  }
  render();
}

function copyAttachmentsForSend() {
  return state.attachments.map(({ id: _id, ...file }) => file);
}

async function runSandboxCode(form) {
  if (!(await ensureLogin())) return;
  const payload = {
    sessionId: state.sessionId,
    code: String(form.get('code') || '').trim(),
    language: String(form.get('language') || 'python'),
  };
  if (!payload.code) return;
  state.sandboxOutput = '正在沙箱中运行代码...';
  render();
  try {
    const body = await apiPost('/v1/sandbox/run-code', payload);
    state.sandboxOutput = formatToolResponse(body);
  } catch (err) {
    state.sandboxOutput = `运行失败：${formatError(err)}`;
  }
  render();
}

async function openBrowserStream() {
  if (!(await ensureLogin())) return;
  state.sandboxOutput = '正在获取 VNC / 浏览器画面...';
  render();
  try {
    const body = await apiPost('/v1/browser/stream', { sessionId: state.sessionId });
    const text = formatToolResponse(body);
    const url = extractUrl(text);
    if (url) state.browserStreamUrl = url;
    state.sandboxOutput = url ? `${text}\n已加载到右侧预览。` : text;
  } catch (err) {
    state.sandboxOutput = `VNC 获取失败：${formatError(err)}`;
  }
  render();
}

async function navigateBrowser(form) {
  if (!(await ensureLogin())) return;
  const url = String(form.get('url') || '').trim();
  if (!url) return;
  state.browserUrl = url;
  state.sandboxOutput = `正在打开浏览器：${url}`;
  render();
  try {
    const body = await apiPost('/v1/browser/navigate', { sessionId: state.sessionId, url });
    state.sandboxOutput = formatToolResponse(body);
  } catch (err) {
    state.sandboxOutput = `浏览器操作失败：${formatError(err)}`;
  }
  render();
}

async function clickBrowser(form) {
  if (!(await ensureLogin())) return;
  const x = Number(form.get('x'));
  const y = Number(form.get('y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    state.sandboxOutput = '点击失败：X/Y 必须是数字';
    render();
    return;
  }
  state.sandboxOutput = `正在点击浏览器坐标 (${x}, ${y})...`;
  render();
  try {
    const body = await apiPost('/v1/browser/click', { sessionId: state.sessionId, x, y });
    state.sandboxOutput = formatToolResponse(body);
  } catch (err) {
    state.sandboxOutput = `点击失败：${formatError(err)}`;
  }
  render();
}

async function typeBrowser(form) {
  if (!(await ensureLogin())) return;
  const text = String(form.get('text') || '');
  if (!text) return;
  state.sandboxOutput = '正在向浏览器输入文本...';
  render();
  try {
    const body = await apiPost('/v1/browser/type', { sessionId: state.sessionId, text });
    state.sandboxOutput = formatToolResponse(body);
  } catch (err) {
    state.sandboxOutput = `输入失败：${formatError(err)}`;
  }
  render();
}

async function captureBrowserScreenshot() {
  if (!(await ensureLogin())) return;
  state.sandboxOutput = '正在截取浏览器画面...';
  render();
  try {
    const body = await apiPost('/v1/browser/screenshot', { sessionId: state.sessionId });
    state.sandboxOutput = formatToolResponse(body);
  } catch (err) {
    state.sandboxOutput = `截图失败：${formatError(err)}`;
  }
  render();
}

async function runAgent(task, attachments = []) {
  if (!(await ensureLogin())) return;
  const payload = { task, sessionId: state.sessionId, attachments: state.attachments };
  if (attachments.length) payload.attachments = attachments;
  const response = await fetch('/v1/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    state.messages.push({ role: 'assistant', text: `请求失败：${response.status}`, time: new Date().toLocaleTimeString() });
    render();
    return;
  }

  const assistant = { role: 'assistant', text: '', time: new Date().toLocaleTimeString() };
  state.messages.push(assistant);
  render();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const event = parseSse(part);
      if (event?.event === 'text_delta' && event.data?.text) {
        assistant.text += event.data.text;
        render();
      }
      if (event?.event === 'done' && event.data?.sessionId) {
        state.sessionId = event.data.sessionId;
        writeStorage('aiop_session_id', state.sessionId);
      }
    }
  }
  await loadPageData(state.page);
}

function insertComposerNewline(textarea) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  if (typeof textarea.setRangeText === 'function') {
    textarea.setRangeText('\n', start, end, 'end');
  } else {
    textarea.value = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function handleComposerKeydown(event) {
  const target = event.target;
  if (!target || target.name !== 'task' || target.tagName !== 'TEXTAREA' || event.key !== 'Enter' || event.isComposing) return;
  if (event.shiftKey || event.altKey) {
    event.preventDefault();
    insertComposerNewline(target);
    return;
  }
  if (!event.shiftKey && !event.altKey) {
    event.preventDefault();
    target.form?.requestSubmit();
  }
}

function parseSse(chunk) {
  const event = /^event: (.+)$/m.exec(chunk)?.[1];
  const dataRaw = /^data: (.+)$/m.exec(chunk)?.[1];
  if (!event || !dataRaw) return null;
  try {
    return { event, data: JSON.parse(dataRaw) };
  } catch {
    return null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-nav], [data-action]');
    if (!target) return;
    const nav = target.dataset.nav;
    const action = target.dataset.action;
    if (nav) {
      state.hiddenNavTip = nav;
      state.page = nav;
      loadPageData(nav);
    }
    if (action === 'toggle-history') state.historyOpen = !state.historyOpen;
    if (action === 'toggle-sandbox') state.sandboxOpen = !state.sandboxOpen;
    if (action === 'new-session') {
      state.sessionId = randomId();
      writeStorage('aiop_session_id', state.sessionId);
      state.messages = [];
      state.attachments = [];
    }
    if (action === 'login') {
      login();
      return;
    }
    if (action === 'test-llm') {
      const form = target.closest('form');
      if (form) testLlmSettings(new FormData(form));
      return;
    }
    if (action === 'run-sandbox-code') {
      const form = document.getElementById('sandbox-code-form');
      if (form) runSandboxCode(new FormData(form));
      return;
    }
    if (action === 'browser-stream') {
      openBrowserStream();
      return;
    }
    if (action === 'browser-navigate') {
      const form = document.getElementById('browser-control-form');
      if (form) navigateBrowser(new FormData(form));
      return;
    }
    if (action === 'browser-click') {
      const form = document.getElementById('browser-control-form');
      if (form) clickBrowser(new FormData(form));
      return;
    }
    if (action === 'browser-type') {
      const form = document.getElementById('browser-control-form');
      if (form) typeBrowser(new FormData(form));
      return;
    }
    if (action === 'browser-screenshot') {
      captureBrowserScreenshot();
      return;
    }
    if (action === 'choose-attachment') {
      document.getElementById('attachment-input')?.click();
      return;
    }
    if (action === 'remove-attachment') {
      state.attachments = state.attachments.filter((file) => file.id !== target.dataset.attachmentId);
      render();
      return;
    }
    if (action === 'test-skill') {
      const form = document.getElementById('skill-test-form');
      if (form) callToolFromForm(new FormData(form));
      return;
    }
    if (action === 'test-mcp') {
      const form = document.getElementById('mcp-test-form');
      if (form) callToolFromForm(new FormData(form));
      return;
    }
    render();
  });

  document.addEventListener('pointermove', (event) => {
    const navButton = event.target.closest?.('.nav-btn');
    if (!state.hiddenNavTip || navButton?.dataset.nav === state.hiddenNavTip) return;
    state.hiddenNavTip = '';
    render();
  });

  document.addEventListener('change', (event) => {
    if (event.target.id !== 'attachment-input') return;
    addAttachments(event.target.files).catch((err) => {
      state.sandboxOutput = `附件读取失败：${formatError(err)}`;
      render();
    });
    event.target.value = '';
  });

  document.addEventListener('keydown', handleComposerKeydown);

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'llm-settings-form') {
      event.preventDefault();
      saveLlmSettings(new FormData(event.target));
      return;
    }
    if (event.target.id !== 'composer') return;
    event.preventDefault();
    const form = new FormData(event.target);
    const task = String(form.get('task') || '').trim();
    const attachments = copyAttachmentsForSend();
    if (!task && !attachments.length) return;
    const displayTask = task || '请分析上传的附件';
    state.messages.push({ role: 'user', text: displayTask, attachments, time: new Date().toLocaleTimeString() });
    state.attachments = [];
    event.target.reset();
    render();
    runAgent(displayTask, attachments);
  });

  render();
  loadPageData(state.page);
}
