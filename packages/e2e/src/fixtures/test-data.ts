/**
 * Test Data Fixtures for E2E Tests
 *
 * Provides consistent test data for seeding the database
 * and making assertions in tests.
 */

export const TEST_USERS = {
  admin: {
    email: 'admin@test.local',
    password: 'admin123',
    name: 'Test Admin',
    role: 'admin',
  },
  user1: {
    email: 'user1@test.local',
    password: 'user123',
    name: 'Test User 1',
    role: 'user',
  },
  user2: {
    email: 'user2@test.local',
    password: 'user456',
    name: 'Test User 2',
    role: 'user',
  },
} as const;

export const TEST_AGENTS = {
  assistant: {
    id: 'agent_e2e_assistant',
    name: 'E2E Test Assistant',
    systemPrompt:
      'You are a helpful assistant for testing purposes. Always respond with "TEST:" prefix.',
    modelId: 'mock-llm-v1',
    isPublic: true,
  },
  coder: {
    id: 'agent_e2e_coder',
    name: 'E2E Test Coder',
    systemPrompt: 'You are a coding assistant for testing. Respond with code examples.',
    modelId: 'mock-llm-v1',
    isPublic: true,
  },
  private: {
    id: 'agent_e2e_private',
    name: 'E2E Private Agent',
    systemPrompt: 'Private agent for testing access control.',
    modelId: 'mock-llm-v1',
    isPublic: false,
    ownerId: 'user_admin',
  },
} as const;

export const TEST_MODELS = {
  mock: {
    id: 'mock-llm-v1',
    name: 'Mock LLM',
    provider: 'mock',
    modelId: 'mock-v1',
    maxTokens: 4096,
    contextWindow: 32000,
    isDefault: true,
  },
} as const;

/**
 * Configuration for E2E test environment
 */
export const E2E_CONFIG = {
  /** WebSocket URL for tests - note the /ws path! */
  wsUrl: process.env.E2E_WS_URL || 'ws://localhost:3002/ws',
  /** HTTP URL for tests */
  httpUrl: process.env.E2E_HTTP_URL || 'http://localhost:3002',
  /** MongoDB URI for direct DB access in tests */
  mongoUri: process.env.E2E_MONGO_URI || 'mongodb://localhost:27018',
  /** Database name */
  dbName: process.env.E2E_DB_NAME || 'teros_e2e',
  /** Default timeout for operations */
  timeout: parseInt(process.env.E2E_TIMEOUT || '10000'),
  /** Enable debug logging */
  debug: process.env.E2E_DEBUG === 'true',
} as const;
