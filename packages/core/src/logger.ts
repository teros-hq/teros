/**
 * Agent Logger - Structured logging with Pino
 *
 * Provides context-aware logging for debugging and monitoring.
 */

import pino from 'pino';
import type { AgentError } from './errors/AgentError';

/**
 * Create Pino logger instance
 * Based on telegram/src/logger.ts configuration
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'debug',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['*.token', '*.apiKey', '*.password', '*.secret', 'ANTHROPIC_API_KEY'],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  base: {
    pid: process.pid,
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
      messageFormat: '{module} {msg}',
    },
  },
});

/**
 * Create child logger with module name
 */
export function createLogger(module: string) {
  return logger.child({ module });
}

/**
 * Module-specific loggers
 */
export const messageLogger = createLogger('MessageHandler');
export const llmLogger = createLogger('AnthropicLLM');
export const conversationLogger = createLogger('ConversationManager');
export const sessionLogger = createLogger('SessionStore');
export const toolLogger = createLogger('ToolExecutor');

/**
 * Log an AgentError with full context
 */
export function logError(error: AgentError, loggerInstance: pino.Logger) {
  loggerInstance.error(
    {
      ...error.getLogContext(),
      err: error.originalError,
    },
    error.message,
  );
}

/**
 * Log levels helper (compatible with existing code)
 */
export const log = {
  /**
   * Log info message with context
   */
  info: (context: string, message: string, data?: Record<string, any>) => {
    logger.info({ module: context, ...data }, message);
  },

  /**
   * Log debug message with context
   */
  debug: (context: string, message: string, data?: Record<string, any>) => {
    logger.debug({ module: context, ...data }, message);
  },

  /**
   * Log warning with context
   */
  warn: (context: string, message: string, data?: Record<string, any>) => {
    logger.warn({ module: context, ...data }, message);
  },

  /**
   * Log error with context (generic error)
   */
  error: (context: string, message: string, error?: Error, data?: Record<string, any>) => {
    logger.error({ module: context, err: error, ...data }, message);
  },

  /**
   * Log AgentError with full context
   */
  agentError: (context: string, error: AgentError) => {
    logger.error(
      {
        module: context,
        ...error.getLogContext(),
        err: error.originalError,
      },
      error.message,
    );
  },
};
