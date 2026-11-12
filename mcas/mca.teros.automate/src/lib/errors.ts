export type AutomateErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TIMEZONE'
  | 'INVALID_CRON'
  | 'INVALID_TIME_EXPRESSION'
  | 'INVALID_SCHEDULE_EXPRESSION'
  | 'AMBIGUOUS_TIME_EXPRESSION'
  | 'PAST_TIME_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'ALREADY_TERMINAL'
  | 'DB_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'NO_USER_CONTEXT'
  | 'NO_WORKSPACE_CONTEXT'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_ERROR';

export class AutomateError extends Error {
  readonly code: AutomateErrorCode;
  readonly suggestion?: string;
  constructor(code: AutomateErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = 'AutomateError';
    this.code = code;
    this.suggestion = suggestion;
  }
}

export function isAutomateError(err: unknown): err is AutomateError {
  return err instanceof AutomateError;
}
