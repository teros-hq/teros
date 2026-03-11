/**
 * @teros/e2e - End-to-End Testing Package
 *
 * Exports utilities for E2E testing of Teros backend.
 */

export type { MockLLMConfig, MockResponse } from './adapters/MockLLMAdapter';
// Adapters
export { createEchoMock, createToolMock, MockLLMAdapter } from './adapters/MockLLMAdapter';
// Fixtures
export { E2E_CONFIG, TEST_AGENTS, TEST_MODELS, TEST_USERS } from './fixtures/test-data';
// Setup utilities
export {
  cleanupTestData,
  closeDb,
  createTestClient,
  getDb,
  globalSetup,
  globalTeardown,
  sleep,
  waitForBackend,
} from './utils/setup';
export type { AuthResponse, TestClientConfig, WsMessage } from './utils/TestClient';
// Test Client
export { createAuthenticatedClient, TestClient } from './utils/TestClient';
