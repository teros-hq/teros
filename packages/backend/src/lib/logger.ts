/**
 * Structured Logger — pino-based
 *
 * Usage:
 *   import { logger } from '../lib/logger'
 *
 *   // Module-level child logger (adds `module` field to every log line)
 *   const log = logger.child({ module: 'MessageHandler' })
 *   log.info({ channelId, agentId }, 'Processing agent response')
 *   log.error({ err, channelId }, 'Failed to process response')
 *
 *   // Request-scoped child (adds `requestId` for correlation)
 *   const reqLog = logger.child({ requestId, userId })
 *   reqLog.debug({ action }, 'Handling WS action')
 *
 * Log levels (lowest → highest):
 *   trace | debug | info | warn | error | fatal
 *
 * Environment:
 *   NODE_ENV=production  → JSON output (machine-readable, no color)
 *   NODE_ENV=development → pino-pretty output (human-readable, colorized)
 *   LOG_LEVEL            → override minimum log level (default: info)
 */

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL ?? 'info'

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '[{module}] {msg}',
        errorLikeObjectKeys: ['err', 'error'],
      },
    }
  : undefined

export const logger = pino(
  {
    level,
    // Serialize Error objects correctly (captures message + stack)
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    // Base fields included in every log line
    base: {
      service: 'teros-backend',
    },
    // Use epoch milliseconds for timestamp (standard for log aggregators)
    timestamp: pino.stdTimeFunctions.epochTime,
  },
  transport ? pino.transport(transport) : undefined,
)

/**
 * Create a module-scoped child logger.
 * Adds a `module` field to every log line for easy filtering.
 *
 * @example
 *   const log = createLogger('McaManager')
 *   log.info({ appId }, 'MCA spawned')
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module })
}

/**
 * Create a request-scoped child logger with a correlation ID.
 * Use this inside WebSocket handlers to trace a single request end-to-end.
 *
 * @example
 *   const reqLog = createRequestLogger(requestId, userId, 'channel.send-message')
 *   reqLog.info({ channelId }, 'Message received')
 */
export function createRequestLogger(
  requestId: string,
  userId: string,
  action: string,
): pino.Logger {
  return logger.child({ requestId, userId, action })
}

export type Logger = pino.Logger
