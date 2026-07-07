import { randomUUID } from 'node:crypto';

/** 单个问题的一个选项。 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** 一个待用户回答的问题。 */
export interface QuestionSpec {
  question: string;
  /** 简短标签（前端做 chip 展示）。 */
  header?: string;
  options: QuestionOption[];
  /** 允许多选。 */
  multiSelect?: boolean;
}

/** 推送前端的待回答问题集合。 */
export interface QuestionPending {
  id: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  questions: QuestionSpec[];
  createdAt: string;
}

/** 用户提交的回答：每个问题 → 选中的 label 列表（含自由输入的“其他”文本）。 */
export type QuestionAnswers = Record<string, string[]>;

interface PendingEntry {
  pending: QuestionPending;
  resolve: (answers: QuestionAnswers | null) => void;
  promise: Promise<QuestionAnswers | null>;
}

/**
 * 进程内待回答问题队列（镜像 InMemoryApprovalStore）：
 * ask_user 工具创建一个 pending 并暂停等待，HTTP 层通过 answer 端点续跑。
 */
export class InMemoryQuestionStore {
  private readonly pending = new Map<string, PendingEntry>();

  create(input: Omit<QuestionPending, 'id' | 'createdAt'>): { pending: QuestionPending; promise: Promise<QuestionAnswers | null> } {
    const id = randomUUID();
    let resolve!: (answers: QuestionAnswers | null) => void;
    const promise = new Promise<QuestionAnswers | null>((r) => {
      resolve = r;
    });
    const entry: PendingEntry = {
      pending: { ...input, id, createdAt: new Date().toISOString() },
      resolve,
      promise,
    };
    this.pending.set(id, entry);
    return { pending: entry.pending, promise };
  }

  get(id: string): QuestionPending | undefined {
    return this.pending.get(id)?.pending;
  }

  list(tenantId: string): QuestionPending[] {
    return [...this.pending.values()].map((e) => e.pending).filter((p) => p.tenantId === tenantId);
  }

  /** 提交回答，续跑等待的工具调用。 */
  answer(id: string, tenantId: string, answers: QuestionAnswers): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.pending.tenantId !== tenantId) return false;
    this.pending.delete(id);
    entry.resolve(answers);
    return true;
  }

  /** 取消（中止/断连）：以 null 续跑，工具据此返回“未获回答”。 */
  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(null);
  }
}
