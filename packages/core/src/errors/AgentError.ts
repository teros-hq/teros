/**
 * Agent Error System - Structured errors with user-friendly messages
 *
 * Architecture:
 * - AgentError (base class) - All agent errors extend this
 * - Specific error classes for different error types
 * - User-friendly messages for UI
 * - Detailed context for logging
 */

export type ErrorType = "llm" | "tool" | "session" | "validation" | "network" | "unknown"

export interface ErrorContext {
  [key: string]: any
}

/**
 * Base Agent Error
 *
 * All errors in the agent system extend this class to provide:
 * - User-friendly message (for UI)
 * - Technical details (for logging)
 * - Structured context (for debugging)
 */
export class AgentError extends Error {
  readonly type: ErrorType
  readonly userMessage: string // Short, user-friendly message
  readonly context: ErrorContext // Technical details for logging
  readonly timestamp: number
  readonly originalError?: Error

  constructor(
    type: ErrorType,
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(technicalMessage)
    this.name = "AgentError"
    this.type = type
    this.userMessage = userMessage
    this.context = context
    this.timestamp = Date.now()
    this.originalError = originalError

    // Maintain stack trace
    if (originalError?.stack) {
      this.stack = originalError.stack
    }
  }

  /**
   * Get formatted message for user (UI)
   */
  getUserMessage(): string {
    return `❌ ${this.userMessage}`
  }

  /**
   * Get full context for logging
   */
  getLogContext(): Record<string, any> {
    return {
      type: this.type,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      timestamp: this.timestamp,
      error: this.originalError?.message,
      stack: this.originalError?.stack || this.stack,
    }
  }
}

/**
 * LLM API Error - Problems with LLM provider (Anthropic)
 */
export class LLMError extends AgentError {
  constructor(
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super("llm", userMessage, technicalMessage, context, originalError)
    this.name = "LLMError"
  }

  static fromAnthropicError(error: any, context: ErrorContext = {}): LLMError {
    // Parse Anthropic error
    const statusCode = error?.status || error?.statusCode
    const errorType = error?.error?.type || error?.type
    const errorMessage = error?.error?.message || error?.message || ""
    const headers = error?.headers

    let userMessage = "Cannot connect to the AI model. Try again in a few seconds."
    let technicalMessage = `Anthropic API error: ${error.message}`
    const additionalContext: ErrorContext = {}

    // Customize based on error type
    if (statusCode === 429) {
      // Rate limit error - extract retry-after info from headers
      const retryAfterSecs = headers?.["retry-after"]
        ? parseInt(headers["retry-after"], 10)
        : undefined

      // Calculate when service will be restored
      const retryAfterMs = retryAfterSecs ? retryAfterSecs * 1000 : undefined
      const resetAt = retryAfterMs ? Date.now() + retryAfterMs : undefined

      // Store rate limit info in context for UI to use
      additionalContext.isRateLimit = true
      additionalContext.retryAfterSecs = retryAfterSecs
      additionalContext.retryAfterMs = retryAfterMs
      additionalContext.resetAt = resetAt
      additionalContext.source = "Claude"

      // User-friendly message with time info
      if (retryAfterSecs) {
        const minutes = Math.ceil(retryAfterSecs / 60)
        const hours = Math.floor(minutes / 60)
        const remainingMins = minutes % 60

        let timeStr: string
        if (hours > 0) {
          timeStr = remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`
        } else {
          timeStr = `${minutes}m`
        }
        userMessage = `⏳ Rate limit reached. The service will recover in ~${timeStr}.`
      } else {
        userMessage = "⏳ Rate limit reached. Try again in a few minutes."
      }
      technicalMessage = `Anthropic API rate limit exceeded (retry-after: ${retryAfterSecs || "unknown"}s)`
    } else if (statusCode === 401) {
      userMessage = "Configuration error. Contact support."
      technicalMessage = "Anthropic API authentication failed (invalid API key)"
    } else if (statusCode === 400) {
      // Check if it's a "prompt too long" error
      if (errorMessage.includes("prompt is too long") || errorMessage.includes("tokens >")) {
        // Extract token counts if available
        const match = errorMessage.match(/(\d+)\s+tokens\s+>\s+(\d+)\s+maximum/)
        const tokenInfo = match ? `(${match[1]} tokens, max ${match[2]})` : ""

        userMessage = `The conversation has grown too long ${tokenInfo}. Auto-compaction will be triggered automatically.`
        technicalMessage = `Anthropic API prompt too long: ${errorMessage}`
      } else {
        userMessage = "There was a problem with your message. Try rephrasing it."
        technicalMessage = "Anthropic API bad request"
      }
    } else if (statusCode >= 500) {
      userMessage = "The AI service is temporarily unavailable. Try again later."
      technicalMessage = "Anthropic API server error"
    } else if (error.message?.includes("timeout")) {
      userMessage = "The response is taking too long. Try again."
      technicalMessage = "Anthropic API timeout"
    }

    return new LLMError(
      userMessage,
      technicalMessage,
      {
        ...context,
        ...additionalContext,
        statusCode,
        errorType,
        originalMessage: error.message,
      },
      error,
    )
  }
}

/**
 * Tool Execution Error - Problems executing MCP tools
 */
export class ToolError extends AgentError {
  constructor(
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super("tool", userMessage, technicalMessage, context, originalError)
    this.name = "ToolError"
  }

  static fromToolExecution(toolName: string, error: any, context: ErrorContext = {}): ToolError {
    const userMessage = `Error executing tool "${toolName}". Try again.`
    const technicalMessage = `Tool execution failed: ${toolName} - ${error.message}`

    return new ToolError(
      userMessage,
      technicalMessage,
      {
        ...context,
        toolName,
        originalMessage: error.message,
      },
      error,
    )
  }
}

/**
 * Session Storage Error - Problems with storage
 */
export class SessionError extends AgentError {
  constructor(
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super("session", userMessage, technicalMessage, context, originalError)
    this.name = "SessionError"
  }

  static fromStorageError(operation: string, error: any, context: ErrorContext = {}): SessionError {
    const userMessage =
      "Error saving history. Your response will be sent, but it may not be saved in the history."
    const technicalMessage = `Session storage error (${operation}): ${error.message}`

    return new SessionError(
      userMessage,
      technicalMessage,
      {
        ...context,
        operation,
        originalMessage: error.message,
      },
      error,
    )
  }
}

/**
 * Validation Error - Invalid input from user
 */
export class ValidationError extends AgentError {
  constructor(
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super("validation", userMessage, technicalMessage, context, originalError)
    this.name = "ValidationError"
  }

  static fromInvalidInput(
    field: string,
    reason: string,
    context: ErrorContext = {},
  ): ValidationError {
    const userMessage = `Your message has a problem: ${reason}. Try again.`
    const technicalMessage = `Validation error: ${field} - ${reason}`

    return new ValidationError(userMessage, technicalMessage, {
      ...context,
      field,
      reason,
    })
  }
}

/**
 * Network Error - Connection problems
 */
export class NetworkError extends AgentError {
  constructor(
    userMessage: string,
    technicalMessage: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super("network", userMessage, technicalMessage, context, originalError)
    this.name = "NetworkError"
  }

  static fromNetworkError(error: any, context: ErrorContext = {}): NetworkError {
    const userMessage = "Connection problems. Check your internet and try again."
    const technicalMessage = `Network error: ${error.message}`

    return new NetworkError(
      userMessage,
      technicalMessage,
      {
        ...context,
        originalMessage: error.message,
      },
      error,
    )
  }
}
