import { CronExpressionParser } from 'cron-parser';

export function nextFireAt(cron: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: 'UTC' }).next().toDate();
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}
