/**
 * Logging Middleware — Logs every request/response through the WsRouter
 *
 * Captures: userId, sessionId, action, inputBytes, outputBytes, durationMs, status, errorCode
 * Writes structured NDJSON to logs/ws-YYYY-MM-DD.ndjson via WsLogger.
 */

import type { WsMiddleware } from '@teros/shared';
import { getWsLogger, jsonBytes } from '../lib/ws-logger';

export const loggingMiddleware: WsMiddleware = async (ctx, action, data, next) => {
  const start = Date.now();
  const inputBytes = jsonBytes(data);
  const logger = getWsLogger();

  try {
    const result = await next();
    const durationMs = Date.now() - start;
    const outputBytes = jsonBytes(result);

    logger.write({
      ts: new Date().toISOString(),
      ip: ctx.ip,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      action,
      inputBytes,
      outputBytes,
      durationMs,
      status: 'ok',
    });

    console.log(`✅ [WsRouter] ${action} | user=${ctx.userId} | ${durationMs}ms | in=${inputBytes}B out=${outputBytes}B`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = (error as any)?.code ?? 'INTERNAL_ERROR';

    logger.write({
      ts: new Date().toISOString(),
      ip: ctx.ip,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      action,
      inputBytes,
      outputBytes: 0,
      durationMs,
      status: 'error',
      errorCode,
      errorMsg: errorMsg.slice(0, 200),
    });

    console.error(`❌ [WsRouter] ${action} | user=${ctx.userId} | ${durationMs}ms | ${errorCode}: ${errorMsg}`);
    throw error;
  }
};
