/**
 * Shared TestServer state for Cucumber hooks.
 *
 * This module holds the singleton TestServer instance that is started in
 * BeforeAll and stopped in AfterAll. It exports helper functions so that
 * world.ts and step definitions can read the live server URL without
 * creating circular import chains.
 */

import { createTestServer, type TestServerInstance } from '@teros/testing';

let _server: TestServerInstance | null = null;

/** Start the embedded TestServer. Called once in BeforeAll. */
export async function startTestServer(): Promise<TestServerInstance> {
  if (_server) return _server;

  _server = await createTestServer({
    mockResponses: [
      { text: 'Hello from the mock server!' },
      { text: 'Sure, I can help with that.' },
      { text: 'Goodbye!' },
    ],
    // Full domain stack: required for workspace.create (channels are
    // workspace-sovereign) and for cross-user broadcasts via PubSubService
    // (realtime.feature) — TER-453.
    enableNavbarStack: true,
  });

  await _server.seedAgents();

  // Expose the URL via env vars so E2E_CONFIG (read at module init time) can
  // be overridden. world.ts reads E2E_CONFIG.wsUrl at createClient() call
  // time, so setting process.env here is sufficient.
  process.env.E2E_WS_URL = `ws://localhost:${_server.port}/ws`;
  process.env.E2E_HTTP_URL = `http://localhost:${_server.port}`;

  return _server;
}

/** Stop the embedded TestServer. Called once in AfterAll. */
export async function stopTestServer(): Promise<void> {
  if (_server) {
    await _server.close();
    _server = null;
  }
}

/** Get the running server (throws if not started). */
export function getTestServer(): TestServerInstance {
  if (!_server) throw new Error('TestServer not started — call startTestServer() first');
  return _server;
}

/** Get the WebSocket URL of the running server. */
export function getWsUrl(): string {
  if (!_server) throw new Error('TestServer not started');
  return `ws://localhost:${_server.port}/ws`;
}

/** Get the HTTP URL of the running server. */
export function getHttpUrl(): string {
  if (!_server) throw new Error('TestServer not started');
  return `http://localhost:${_server.port}`;
}
