/**
 * Test Setup Utilities
 *
 * Provides helpers for setting up and tearing down E2E tests.
 */

import { type Db, MongoClient } from 'mongodb';
import { E2E_CONFIG, TEST_USERS } from '../fixtures/test-data';
import { TestClient } from './TestClient';

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

/**
 * Get a MongoDB connection for direct database access in tests
 */
export async function getDb(): Promise<Db> {
  if (!db) {
    mongoClient = new MongoClient(E2E_CONFIG.mongoUri);
    await mongoClient.connect();
    db = mongoClient.db(E2E_CONFIG.dbName);
  }
  return db;
}

/**
 * Close the MongoDB connection
 */
export async function closeDb(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
  }
}

/**
 * Wait for the backend to be healthy
 */
export async function waitForBackend(maxAttempts = 30, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${E2E_CONFIG.httpUrl}/health`);
      if (response.ok) {
        console.log(`✓ Backend is healthy after ${i + 1} attempts`);
        return true;
      }
    } catch {
      // Backend not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Backend not healthy after ${maxAttempts} attempts`);
}

/**
 * Create an authenticated test client for a test user
 */
export async function createTestClient(
  userKey: keyof typeof TEST_USERS = 'user1',
): Promise<TestClient> {
  const user = TEST_USERS[userKey];
  const client = new TestClient({
    url: E2E_CONFIG.wsUrl,
    timeout: E2E_CONFIG.timeout,
    debug: E2E_CONFIG.debug,
  });

  await client.connect();
  const auth = await client.authenticate(user.email, user.password);

  if (auth.type === 'auth:error') {
    throw new Error(`Failed to authenticate as ${user.email}: ${auth.error}`);
  }

  return client;
}

/**
 * Clean up test data (channels, messages) but keep users and agents
 */
export async function cleanupTestData(): Promise<void> {
  const database = await getDb();
  await database.collection('channels').deleteMany({});
  await database.collection('messages').deleteMany({});
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global test setup - call in beforeAll
 */
export async function globalSetup(): Promise<void> {
  console.log('🚀 Starting E2E test setup...');
  await waitForBackend();
  console.log('✅ E2E test setup complete');
}

/**
 * Global test teardown - call in afterAll
 */
export async function globalTeardown(): Promise<void> {
  console.log('🧹 Cleaning up E2E tests...');
  await closeDb();
  console.log('✅ E2E test cleanup complete');
}
