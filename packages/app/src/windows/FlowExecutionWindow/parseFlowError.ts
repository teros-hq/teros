/**
 * Parse a structured error from the workflows MCA.
 *
 * The MCA's `toToolError()` throws errors whose `.message` is a JSON string:
 *   {"error":true,"code":"FLOW_NOT_FOUND","message":"Flow not found: xxx","suggestion":"Make sure..."}
 *
 * The SDK wraps it as `Error: ${message}`, and the backend passes it through
 * as a string in `result.output`. This utility tries to parse that JSON and
 * extract the structured fields. If parsing fails, it returns the raw string
 * as the message.
 */

export interface ParsedFlowError {
  code: string;
  message: string;
  suggestion: string | null;
  /** The raw error string (for debugging) */
  raw: string;
}

/**
 * Parse a raw error string (from MCA tool execution) into structured fields.
 *
 * @param raw - The error string from the MCA (may be JSON or plain text)
 * @returns Parsed error with code, message, and suggestion
 */
export function parseFlowError(raw: string): ParsedFlowError {
  // The SDK wraps errors as "Error: {json...}" — strip the prefix
  let cleaned = raw;
  if (cleaned.startsWith('Error: ')) {
    cleaned = cleaned.slice(7);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && parsed.error === true) {
      return {
        code: parsed.code ?? 'UNKNOWN',
        message: parsed.message ?? cleaned,
        suggestion: parsed.suggestion ?? null,
        raw,
      };
    }
  } catch {
    // Not JSON — fall through to plain text handling
  }

  // Not structured — return as plain message
  return {
    code: 'UNKNOWN',
    message: raw,
    suggestion: null,
    raw,
  };
}

/**
 * Extract an error message from a tool execution result.
 *
 * Handles multiple shapes:
 * - String: "Error: {json...}" or plain text
 * - Object with .error or .message field
 * - Object that is itself the structured error
 */
export function extractFlowError(result: unknown): ParsedFlowError | null {
  if (!result) return null;

  if (typeof result === 'string') {
    return parseFlowError(result);
  }

  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;

    // Already structured { error, code, message, suggestion }
    if (obj.error === true && (obj.code || obj.message)) {
      return {
        code: (obj.code as string) ?? 'UNKNOWN',
        message: (obj.message as string) ?? 'Unknown error',
        suggestion: (obj.suggestion as string) ?? null,
        raw: JSON.stringify(obj),
      };
    }

    // { error: "message" } shape
    if (typeof obj.error === 'string') {
      return parseFlowError(obj.error);
    }

    // { message: "..." } shape
    if (typeof obj.message === 'string') {
      return parseFlowError(obj.message);
    }
  }

  return null;
}
