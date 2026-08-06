/**
 * @teros/testing
 *
 * Shared test infrastructure for the Teros monorepo.
 *
 * Exports:
 *   - TestServer / createTestServer  — in-process WebSocket server backed by
 *                                      a real MongoDB (ephemeral DB per test run)
 *   - TestWebSocketClient            — typed WS client for sending/receiving messages
 *   - fixtures                       — canonical test data (agents, models, cores)
 *   - factories                      — entity builders with sensible defaults
 *   - helpers                        — sleep, retry, randomId, etc.
 */

// Core test server
export {
  createTestServer,
  TestWebSocketClient,
  type TestServerInstance,
  type TestServerOptions,
} from './TestServer.js';

// Test data
export * from './fixtures/index.js';
export * from './factories/index.js';
export * from './helpers/index.js';
