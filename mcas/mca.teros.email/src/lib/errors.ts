/**
 * Error codes and helpers — `[CODE] message` convention (SDK-wide).
 *
 * Every tool failure carries one of these codes as the first token of the
 * message so agents can self-correct (the hint tells them what to do).
 */

export type EmailErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'JMAP_ERROR'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';

export class ToolError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(`[${code}] ${message}${hint ? ` — ${hint}` : ''}`);
    this.name = 'ToolError';
  }
}

export function toolError(code: EmailErrorCode, message: string, hint?: string): ToolError {
  return new ToolError(code, message, hint);
}
