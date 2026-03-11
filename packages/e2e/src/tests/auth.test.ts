/**
 * E2E Tests: Authentication
 *
 * Tests for user authentication flows:
 * - Login with email/password
 * - Login with token
 * - Invalid credentials
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { E2E_CONFIG, TEST_USERS } from '../fixtures/test-data';
import { globalSetup, globalTeardown } from '../utils/setup';
import { TestClient } from '../utils/TestClient';

describe('Authentication E2E', () => {
  let client: TestClient;

  beforeAll(async () => {
    await globalSetup();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  afterEach(async () => {
    if (client?.isConnected()) {
      await client.disconnect();
    }
  });

  test('should connect to WebSocket server', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  test('should authenticate with valid credentials', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    const response = await client.authenticate(TEST_USERS.user1.email, TEST_USERS.user1.password);

    expect(response.type).toBe('auth_success');
    expect(response.userId).toBeDefined();
    expect(response.userId).toBe('user_user1');
    expect(response.sessionToken).toBeDefined();
    expect(response.role).toBe('user');
  });

  test('should reject invalid credentials', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    const response = await client.authenticate(TEST_USERS.user1.email, 'wrongpassword');

    expect(response.type).toBe('auth_error');
    expect(response.error).toBeDefined();
  });

  test('should reject non-existent user', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    const response = await client.authenticate('nonexistent@test.local', 'password123');

    expect(response.type).toBe('auth_error');
  });

  test('should authenticate with token after login', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    // First login to get token
    const loginResponse = await client.authenticate(
      TEST_USERS.user1.email,
      TEST_USERS.user1.password,
    );
    expect(loginResponse.type).toBe('auth_success');
    const token = loginResponse.sessionToken!;

    // Disconnect and reconnect
    await client.disconnect();

    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    // Authenticate with token
    const tokenResponse = await client.authenticateWithToken(token);
    expect(tokenResponse.type).toBe('auth_success');
    expect(tokenResponse.userId).toBe('user_user1');
  });

  test('should reject invalid token', async () => {
    client = new TestClient({ url: E2E_CONFIG.wsUrl });
    await client.connect();

    const response = await client.authenticateWithToken('invalid-token-12345');
    expect(response.type).toBe('auth_error');
  });
});
