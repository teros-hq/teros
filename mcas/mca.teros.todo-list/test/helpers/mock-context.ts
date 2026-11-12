/**
 * Mock ToolContext factory — mirrors the SDK's ToolContext shape for testing
 * the thin client.
 *
 * `backend.invokeAction` is a fake backend: it records every call
 * (`_calls`) and answers from a per-action table (`respond`). An entry that
 * is an Error is thrown as the SDK's McaBackendClient would throw it on a
 * non-2xx answer (with `.response` = the dispatcher's JSON body).
 * `backend.emitEvent` records emitted events (`_events`).
 */

import type { ToolContext } from '@teros/mca-sdk';

export interface ActionCall {
  actionPath: string;
  body: Record<string, unknown>;
}

export type ActionResponder = (body: Record<string, unknown>) => unknown;

export interface MockContextOptions {
  /** Answers per action path, e.g. { 'todo/get-node': () => ({ node }) }. */
  respond?: Record<string, ActionResponder>;
  /** Set to true to simulate a context without a backend client. */
  noBackend?: boolean;
}

export type MockContext = ToolContext & {
  _calls: ActionCall[];
  _events: Array<{ name: string; payload: unknown }>;
};

/** Build the error the SDK client throws for a non-2xx action response. */
export function backendError(status: number, body: Record<string, unknown>): Error {
  const err = new Error(`Backend request failed: ${status} - ${String(body.error ?? '')}`) as Error & {
    code: string;
    statusCode: number;
    response: unknown;
  };
  err.code = 'BACKEND_ERROR';
  err.statusCode = status;
  err.response = body;
  return err;
}

export function makeMockContext(options: MockContextOptions = {}): MockContext {
  const calls: ActionCall[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const respond = options.respond ?? {};

  const backend = options.noBackend
    ? null
    : {
        invokeAction: async (actionPath: string, body: Record<string, unknown> = {}) => {
          calls.push({ actionPath, body });
          const responder = respond[actionPath];
          if (!responder) throw backendError(404, { error: `Unknown action: ${actionPath}` });
          const answer = responder(body);
          if (answer instanceof Error) throw answer;
          return answer;
        },
        emitEvent: (name: string, payload: unknown) => {
          events.push({ name, payload });
        },
      };

  return {
    execution: {
      userId: 'test-user',
      appId: 'app_test',
      mcaId: 'mca.teros.todo-list',
      requestId: 'test-req',
    },
    backend,
    signal: new AbortController().signal,
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => ({}),
    updateUserSecrets: async () => {},
    getScope: () => 'test-user',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
    _calls: calls,
    _events: events,
  } as unknown as MockContext;
}

/**
 * Extract the structured content from a tool handler result.
 * The `structured()` helper wraps data in { content, structuredContent }.
 */
export function getResult<T = any>(result: any): T {
  if (result && result.structuredContent) {
    return result.structuredContent as T;
  }
  return result as T;
}
