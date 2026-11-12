/**
 * Agent Apps Adapter — Protocol Client
 *
 * Stateless HTTP client for the Agent Apps v2.0 protocol.
 * Handles message envelope creation, sending, and response parsing.
 *
 * ZERO external dependencies — uses only Node fetch API.
 */

import type { ProtocolMessage, Logger } from './types';
import { consoleLogger } from './types';

// ---------------------------------------------------------------------------
// Message ID generation
// ---------------------------------------------------------------------------

let counter = 0;

export function generateMessageId(): string {
  return `msg_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEnvelope(type: string, sessionId?: string): ProtocolMessage {
  return {
    id: generateMessageId(),
    type,
    timestamp: new Date().toISOString(),
    version: '2.0',
    ...(sessionId ? { sessionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Protocol Client
// ---------------------------------------------------------------------------

export interface SendOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Send a protocol message to a station and return the response.
 *
 * This is the ONLY function that touches the network. Every other module
 * in the adapter delegates here, making transport changes trivial.
 */
export async function send(
  stationUrl: string,
  message: ProtocolMessage,
  token?: string,
  options: SendOptions = {},
  logger: Logger = consoleLogger,
): Promise<ProtocolMessage> {
  const { timeoutMs = 30_000, signal: externalSignal } = options;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  // Compose signals: external abort OR timeout
  const combinedSignal = externalSignal
    ? composeAbortSignals(externalSignal, abortController.signal)
    : abortController.signal;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const url = `${stationUrl.replace(/\/+$/, '')}/messages`;

    logger.debug('Sending protocol message', {
      url,
      type: message.type,
      id: message.id,
      sessionId: message.sessionId,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProtocolError(
        `Station responded ${response.status}`,
        response.status >= 500 ? 'CONNECTION_FAILED' : 'PROTOCOL_ERROR',
        { httpStatus: response.status, body },
      );
    }

    const result = (await response.json()) as ProtocolMessage;

    logger.debug('Received protocol response', {
      type: result.type,
      id: result.id,
      requestId: message.id,
    });

    return result;
  } catch (error: any) {
    if (error instanceof ProtocolError) throw error;

    if (error.name === 'AbortError') {
      throw new ProtocolError(
        `Request timed out after ${timeoutMs}ms`,
        'TIMEOUT',
        { timeoutMs, messageType: message.type },
      );
    }

    throw new ProtocolError(
      `Network error: ${error.message}`,
      'CONNECTION_FAILED',
      { originalError: error.message },
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Protocol-level convenience methods
// ---------------------------------------------------------------------------

export async function initialize(
  stationUrl: string,
  host: { name: string; version: string },
  capabilities: { directConnection?: boolean; platformActions?: string[] },
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('initialize'),
    supportedVersions: ['2.0'],
    host,
    capabilities: { directConnection: false, ...capabilities },
  };
  return send(stationUrl, msg, token, options, logger);
}

export async function sessionOpen(
  stationUrl: string,
  installationId: string,
  tenant: { userId: string; workspaceId?: string },
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('session_open'),
    installationId,
    tenant,
  };
  return send(stationUrl, msg, token, options, logger);
}

export async function sessionClose(
  stationUrl: string,
  sessionId: string,
  reason: string,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('session_close', sessionId),
    reason,
  };
  return send(stationUrl, msg, token, options, logger);
}

export async function listTools(
  stationUrl: string,
  sessionId: string,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg = createEnvelope('list_tools', sessionId);
  return send(stationUrl, msg, token, options, logger);
}

export async function callTool(
  stationUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('tool_call', sessionId),
    tool: toolName,
    arguments: args,
    context,
  };
  return send(stationUrl, msg, token, options, logger);
}

export async function healthCheck(
  stationUrl: string,
  sessionId: string,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg = createEnvelope('health_check', sessionId);
  return send(stationUrl, msg, token, options, logger);
}

export async function stationHealth(
  stationUrl: string,
  token?: string,
  verbose = false,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('controller_health'),
    verbose,
  };
  return send(stationUrl, msg, token, options, logger);
}

// ---------------------------------------------------------------------------
// UI Resources
// ---------------------------------------------------------------------------

export async function listUiResources(
  stationUrl: string,
  sessionId: string,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg = createEnvelope('list_ui_resources', sessionId);
  return send(stationUrl, msg, token, options, logger);
}

export async function getUiResource(
  stationUrl: string,
  sessionId: string,
  name: string,
  params: Record<string, unknown>,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('get_ui_resource', sessionId),
    name,
    params,
  };
  return send(stationUrl, msg, token, options, logger);
}

export async function submitUiResource(
  stationUrl: string,
  sessionId: string,
  name: string,
  values: Record<string, unknown>,
  token?: string,
  options?: SendOptions,
  logger?: Logger,
): Promise<ProtocolMessage> {
  const msg: ProtocolMessage = {
    ...createEnvelope('submit_ui_resource', sessionId),
    name,
    values,
  };
  return send(stationUrl, msg, token, options, logger);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set([
  'TIMEOUT',
  'CONNECTION_FAILED',
  'APP_CRASHED',
  'RATE_LIMITED',
  'NOT_READY',
  'SPAWN_FAILED',
  'CONTROLLER_AT_CAPACITY',
]);

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function composeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
