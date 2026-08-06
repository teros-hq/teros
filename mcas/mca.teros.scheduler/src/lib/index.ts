import { SchedulerDB } from '../db';

export const db = new SchedulerDB();

export { SchedulerError, isSchedulerError } from './errors';
export type { SchedulerErrorCode } from './errors';
export {
  isValidIanaTimezone,
  resolveDefaultTimezone,
  assertValidTimezone,
} from './timezone';
export {
  parseTimeExpression,
  parseDelayExpression,
  formatNextRun,
  previewOccurrences,
} from './time';
export type { ParsedTime, ParseLocale, ParseTimeOptions } from './time';
export {
  isValidCronExpression,
  assertValidCron,
  getNextCronRun,
  previewCronOccurrences,
  describeCronExpression,
} from './cron';
export { formatReminder, formatRecurringTask } from './format';
export type { FormattedReminder, FormattedRecurringTask, ReminderStatus } from './format';
export type {
  Reminder,
  RecurringTask,
  Execution,
  PageResult,
  RemindersQuery,
  RecurringTasksQuery,
  BulkCancelFilter,
} from '../db';
