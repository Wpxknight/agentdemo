import { CronExpressionParser } from 'cron-parser';

/** 计算 cron 在 after 之后的下一次触发时间。按 UTC 解释 cron，保证多副本一致。 */
export function nextRunAt(cron: string, after: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz: 'UTC' });
  return it.next().toDate();
}

/** 校验 cron 表达式是否合法。 */
export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}
