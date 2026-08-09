import { CronExpressionParser } from 'cron-parser';

export const DEFAULT_SCHEDULER_TIMEZONE = 'UTC';

export function nextFireAt(cron: string, after: Date, timezone = DEFAULT_SCHEDULER_TIMEZONE): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isValidCron(cron: string, timezone = DEFAULT_SCHEDULER_TIMEZONE): boolean {
  try {
    if (!isValidTimezone(timezone)) return false;
    CronExpressionParser.parse(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

export function assertValidCron(cron: string, timezone = DEFAULT_SCHEDULER_TIMEZONE): void {
  if (!isValidCron(cron, timezone)) throw new Error(`非法 cron 表达式: ${cron}`);
}
