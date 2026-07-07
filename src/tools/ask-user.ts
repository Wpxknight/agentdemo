import type { JsonValue, ToolResult } from '../model/types.js';
import type { QuestionSpec } from '../agent/question.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';

/**
 * ask_user 工具（借鉴 Claude Code AskUserQuestionTool）：
 * 运行中向用户提结构化选择题以澄清需求 / 获取偏好 / 让用户决策。
 * 每次 1-4 题，每题 2-4 个选项；前端自动附“其他”自由输入项。
 * 需要交互端（HTTP SSE）：通过 ctx.askUser 暂停等待；无交互端时返回错误由模型自行决定。
 */
function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function parseQuestions(args: JsonValue): QuestionSpec[] {
  const raw = asObject(args).questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    throw new Error('questions 必须是 1-4 个问题的数组');
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    const o = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, JsonValue>) : {};
    const question = typeof o.question === 'string' ? o.question.trim() : '';
    if (!question) throw new Error('每个问题须有非空 question');
    if (seen.has(question)) throw new Error('问题文本必须唯一');
    seen.add(question);
    const header = typeof o.header === 'string' ? o.header.slice(0, 12) : undefined;
    const optsRaw = o.options;
    if (!Array.isArray(optsRaw) || optsRaw.length < 2 || optsRaw.length > 4) {
      throw new Error(`问题「${question}」需 2-4 个选项`);
    }
    const labels = new Set<string>();
    const options = optsRaw.map((opt) => {
      const oo = opt && typeof opt === 'object' && !Array.isArray(opt) ? (opt as Record<string, JsonValue>) : {};
      const label = typeof oo.label === 'string' ? oo.label.trim() : '';
      if (!label) throw new Error('每个选项须有非空 label');
      if (labels.has(label)) throw new Error(`问题「${question}」的选项 label 必须唯一`);
      labels.add(label);
      return { label, description: typeof oo.description === 'string' ? oo.description : undefined };
    });
    return { question, header, options, multiSelect: o.multiSelect === true };
  });
}

export function buildAskUserTool(): ToolHandler {
  return {
    def: {
      name: 'ask_user',
      description:
        '向用户提结构化选择题以澄清需求、获取偏好或让其决策（如缺少平台地址/参数时）。'
        + '1-4 题，每题 2-4 个选项；用户还可自由输入“其他”。仅在确有必要时使用，不要用于可自行判断的问题。',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1-4 个问题',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '完整的问题文本' },
                header: { type: 'string', description: '≤12 字的简短标签' },
                options: {
                  type: 'array',
                  description: '2-4 个选项',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: '选项显示文本' },
                      description: { type: 'string', description: '选项说明（可选）' },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: { type: 'boolean', description: '是否允许多选' },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
    async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
      const questions = parseQuestions(args);
      if (!ctx.askUser) {
        return {
          id: '',
          content: '当前运行无交互端，无法向用户提问。请基于已知信息继续，或在需要的信息缺失时明确说明。',
          isError: true,
        };
      }
      const answers = await ctx.askUser(questions);
      if (!answers) {
        return { id: '', content: '用户未回答（运行被中止或无响应）。', isError: true };
      }
      const lines = questions.map((q) => {
        const picked = answers[q.question] ?? [];
        return `Q: ${q.question}\nA: ${picked.length ? picked.join('、') : '(未选择)'}`;
      });
      return { id: '', content: `用户回答：\n${lines.join('\n\n')}` };
    },
  };
}
