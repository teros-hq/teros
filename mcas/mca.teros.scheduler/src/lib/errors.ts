export type SchedulerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TIMEZONE'
  | 'INVALID_CRON'
  | 'INVALID_TIME_EXPRESSION'
  | 'AMBIGUOUS_TIME_EXPRESSION'
  | 'PAST_TIME_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'ALREADY_TERMINAL'
  | 'DB_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'NO_USER_CONTEXT';

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  readonly suggestion?: string;
  constructor(code: SchedulerErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.suggestion = suggestion;
  }
}

export function isSchedulerError(err: unknown): err is SchedulerError {
  return err instanceof SchedulerError;
}
