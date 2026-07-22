import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Ban, ChevronLeft, ChevronRight, RefreshCcw, RotateCcw } from 'lucide-react';
import type { AgentRunDetailBody, AgentRunListBody, AgentRunStatus, AgentRunSummary } from '../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

interface RunCenterApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

const PAGE_SIZE = 20;
const NON_TERMINAL = new Set<AgentRunStatus>(['queued', 'running', 'waiting']);
const ACTION_PATH = { cancel: '/cancel', resume: '/resume' } as const;
const STATUS_OPTIONS: Array<{ value: AgentRunStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '运行中' },
  { value: 'waiting', label: '等待交互' },
  { value: 'queued', label: '排队中' },
  { value: 'recovery_required', label: '需要恢复' },
  { value: 'failed', label: '失败' },
  { value: 'succeeded', label: '成功' },
  { value: 'cancelled', label: '已取消' },
];

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: '排队中', running: '运行中', waiting: '等待交互', succeeded: '成功',
  failed: '失败', cancelled: '已取消', recovery_required: '需要恢复',
};

export function RunCenterPage({ api }: { api: RunCenterApi }) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<AgentRunStatus | 'all'>('all');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detail, setDetail] = useState<AgentRunDetailBody | null>(null);
  const [busyAction, setBusyAction] = useState<'cancel' | 'resume' | ''>('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const loadDetail = useCallback(async (runId: string) => {
    if (!runId) return setDetail(null);
    const body = await api.get<AgentRunDetailBody>(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    setDetail(body);
  }, [api]);

  const loadRuns = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status !== 'all') query.set('status', status);
      const body = await api.get<AgentRunListBody>(`/v1/agent/runs?${query}`);
      setRuns(body.runs);
      setTotal(body.total);
      const nextSelected = body.runs.some((run) => run.runId === selectedRunId)
        ? selectedRunId
        : body.runs[0]?.runId ?? '';
      setSelectedRunId(nextSelected);
      if (nextSelected) await loadDetail(nextSelected);
      else setDetail(null);
      setMessage('');
    } catch (error) {
      setMessage(`加载运行记录失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api, loadDetail, offset, selectedRunId, status]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const shouldPoll = useMemo(
    () => Boolean(busyAction) || runs.some((run) => NON_TERMINAL.has(run.status)),
    [busyAction, runs],
  );
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void loadRuns(true), 5_000);
    return () => window.clearInterval(timer);
  }, [loadRuns, shouldPoll]);

  async function runAction(action: 'cancel' | 'resume') {
    if (!detail) return;
    setBusyAction(action);
    setMessage(action === 'cancel' ? '正在请求取消...' : '正在从 checkpoint 恢复...');
    try {
      await api.post(`/v1/agent/runs/${encodeURIComponent(detail.run.runId)}${ACTION_PATH[action]}`);
      setMessage(action === 'cancel' ? '取消请求已持久化。' : '恢复请求已受理。');
      await loadRuns(true);
    } catch (error) {
      setMessage(`操作失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusyAction('');
    }
  }

  return (
    <div className="run-center-page">
      <div className="page-title run-center-heading">
        <div>
          <h1>运行中心</h1>
          <p className="page-subtitle">查看 Agent Run 生命周期、LangGraph 节点时间线并执行安全恢复。</p>
        </div>
        <Button variant="outline" type="button" aria-label="刷新运行记录" disabled={loading} onClick={() => void loadRuns()}>
          <RefreshCcw className={cn(loading && 'run-center-spin')} />刷新
        </Button>
      </div>

      <div className="run-center-toolbar">
        <label>
          <span>状态筛选</span>
          <Select value={status} onValueChange={(value) => { setOffset(0); setStatus(value as AgentRunStatus | 'all'); }}>
            <SelectTrigger aria-label="状态筛选"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <span>{total} 条运行记录</span>
        {message ? <span className="run-center-message" role="status">{message}</span> : null}
      </div>

      <div className="run-center-layout">
        <section className="run-center-list" aria-label="Agent Run 列表">
          <div className="run-center-table-scroll">
            <Table className="aios-table">
              <TableHeader><TableRow>
                <TableHead>状态</TableHead><TableHead>Run / Session</TableHead><TableHead>Graph</TableHead>
                <TableHead>当前节点</TableHead><TableHead>步骤</TableHead><TableHead>Token</TableHead><TableHead>耗时</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.runId} data-state={run.runId === selectedRunId ? 'selected' : undefined} onClick={() => { setSelectedRunId(run.runId); void loadDetail(run.runId); }}>
                    <TableCell><RunStatus status={run.status} /></TableCell>
                    <TableCell><strong>{shortId(run.runId)}</strong><small>{run.sessionId}</small></TableCell>
                    <TableCell>{run.graphName}<small>{run.graphVersion} · {run.kernel}</small></TableCell>
                    <TableCell>{run.currentNode ?? '-'}</TableCell>
                    <TableCell>{run.stepCount}</TableCell>
                    <TableCell>{formatTokens(totalTokens(run))}</TableCell>
                    <TableCell>{formatDuration(run)}</TableCell>
                  </TableRow>
                ))}
                {!runs.length ? <TableRow><TableCell colSpan={7}><div className="run-center-empty"><Activity />暂无符合条件的运行记录</div></TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
          <div className="run-center-pagination">
            <span>第 {Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
            <Button size="icon" variant="outline" aria-label="上一页" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft /></Button>
            <Button size="icon" variant="outline" aria-label="下一页" disabled={offset + runs.length >= total} onClick={() => setOffset(offset + PAGE_SIZE)}><ChevronRight /></Button>
          </div>
        </section>

        <aside className="run-center-detail" aria-label="Run 详情">
          {detail ? <RunDetail detail={detail} busy={Boolean(busyAction)} onCancel={() => void runAction('cancel')} onResume={() => void runAction('resume')} />
            : <div className="run-center-empty"><Activity />选择一条 Run 查看详情</div>}
        </aside>
      </div>
    </div>
  );
}

function RunDetail({ detail, busy, onCancel, onResume }: { detail: AgentRunDetailBody; busy: boolean; onCancel: () => void; onResume: () => void }) {
  const run = detail.run;
  return <>
    <header className="run-detail-header">
      <div><span>RUN</span><h2>{run.runId}</h2><RunStatus status={run.status} /></div>
      <div className="run-detail-actions">
        <Button variant="outline" disabled={busy || !detail.canCancel} onClick={onCancel}><Ban />取消</Button>
        <Button disabled={busy || !detail.canResume} onClick={onResume}><RotateCcw />从 checkpoint 恢复</Button>
      </div>
    </header>
    {detail.recoveryBlockedReason ? <p className="run-recovery-warning">{detail.recoveryBlockedReason}</p> : null}
    {run.errorMessage ? <p className="run-error-message">{run.errorMessage}</p> : null}
    <dl className="run-detail-metrics">
      <div><dt>Session</dt><dd>{run.sessionId}</dd></div><div><dt>用户</dt><dd>{run.userId}</dd></div>
      <div><dt>Graph</dt><dd>{run.graphName} / {run.graphVersion}</dd></div><div><dt>当前节点</dt><dd>{run.currentNode ?? '-'}</dd></div>
      <div><dt>步骤</dt><dd>{run.stepCount}</dd></div><div><dt>Token</dt><dd>{formatTokens(totalTokens(run))}</dd></div>
      <div><dt>耗时</dt><dd>{formatDuration(run)}</dd></div><div><dt>租约</dt><dd>{run.leaseActive ? '活动' : '已释放'}</dd></div>
    </dl>
    <Tabs defaultValue="timeline" className="run-detail-tabs">
      <TabsList><TabsTrigger value="timeline">Timeline</TabsTrigger><TabsTrigger value="interactions">交互 ({detail.interactions.length})</TabsTrigger><TabsTrigger value="tools">工具执行 ({detail.tools.length})</TabsTrigger></TabsList>
      <TabsContent value="timeline"><div className="run-timeline">{detail.events.map((event, index) => <div className="run-timeline-item" key={event.id ?? `${event.createdAt}-${index}`}><span /><div><strong>{event.node ?? event.type}</strong><Badge variant="outline">{event.status ?? event.type}</Badge><small>{formatDateTime(event.createdAt)}</small></div></div>)}{!detail.events.length ? <p>暂无 Timeline 事件</p> : null}</div></TabsContent>
      <TabsContent value="interactions"><CompactRows empty="暂无交互" rows={detail.interactions.map((item) => [item.kind, item.status, formatDateTime(item.createdAt)])} /></TabsContent>
      <TabsContent value="tools"><CompactRows empty="暂无工具执行" rows={detail.tools.map((item) => [item.toolName, item.status, formatDateTime(item.startedAt)])} /></TabsContent>
    </Tabs>
  </>;
}

function CompactRows({ rows, empty }: { rows: string[][]; empty: string }) {
  if (!rows.length) return <p className="run-center-empty compact">{empty}</p>;
  return <div className="run-compact-rows">{rows.map((row, index) => <div key={`${row[0]}-${index}`}>{row.map((cell) => <span key={cell}>{cell}</span>)}</div>)}</div>;
}

function RunStatus({ status }: { status: AgentRunStatus }) {
  return <Badge variant="outline" className={`run-status run-status-${status}`}>{STATUS_LABELS[status]}</Badge>;
}

function totalTokens(run: AgentRunSummary): number { return run.usage.inputTokens + run.usage.outputTokens + run.usage.cacheReadTokens + run.usage.cacheCreationTokens; }
function formatTokens(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value); }
function shortId(value: string): string { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function formatDateTime(value?: string): string { return value ? new Date(value).toLocaleString('zh-CN') : '-'; }
function formatDuration(run: AgentRunSummary): string {
  const start = run.startedAt ? new Date(run.startedAt).getTime() : new Date(run.createdAt).getTime();
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
