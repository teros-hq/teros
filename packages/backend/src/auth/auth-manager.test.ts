/**
 * Unit tests for AuthManager
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Db, MongoClient, ObjectId } from 'mongodb';
import { secrets } from '../secrets/secrets-manager';
import { type AuthManager, initAuth } from './auth-manager';

describe('AuthManager', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let auth: AuthManager;

  const testUserId = 'test-user-' + Date.now();
  const testAppId = new ObjectId().toString();
  const testMcaId = 'mca.teros.gmail';

  beforeAll(async () => {
    // Load secrets
    await secrets.load();

    // Connect to MongoDB
    const dbConfig = secrets.requireSystem('database');
    mongoClient = new MongoClient(dbConfig.uri);
    await mongoClient.connect();
    db = mongoClient.db(dbConfig.database);

    // Initialize auth
    auth = initAuth(db);

    // Insert test app
    await db.collection('apps').insertOne({
      _id: new ObjectId(testAppId),
      mcaId: testMcaId,
      name: 'Test App',
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await db.collection('user_credentials').deleteMany({ userId: testUserId });
    await db.collection('user_encryption_keys').deleteMany({ userId: testUserId });
    await db.collection('apps').deleteOne({ _id: new ObjectId(testAppId) });

    await mongoClient.close();
  });

  afterEach(async () => {
    // Clean up after each test
    await db.collection('user_credentials').deleteMany({ userId: testUserId });
  });

  describe('credential storage', () => {
    test('should store and retrieve credentials', async () => {
      const userAuth = auth.forUser(testUserId);

      const testCreds = {
        accessToken: 'ya29.test-token',
        refreshToken: 'refresh-test',
        email: 'test@example.com',
        expiresAt: Date.now() + 3600000,
      };

      // Store
      await userAuth.app(testAppId).set(testCreds);

      // Retrieve
      const retrieved = await userAuth.app(testAppId).get();

      expect(retrieved).toBeDefined();
      expect(retrieved.accessToken).toBe(testCreds.accessToken);
      expect(retrieved.refreshToken).toBe(testCreds.refreshToken);
      expect(retrieved.email).toBe(testCreds.email);
    });

    test('should encrypt credentials in database', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'secret-token',
        refreshToken: 'secret-refresh',
      });

      // Check that data is encrypted in DB
      const doc = await db.collection('user_credentials').findOne({
        userId: testUserId,
        appId: testAppId,
      });

      expect(doc).toBeDefined();
      expect(doc?.encryptedData).toBeDefined();
      expect(doc?.encryptionIv).toBeDefined();
      expect(doc?.encryptionTag).toBeDefined();

      // Encrypted data should not contain plaintext
      expect(doc?.encryptedData).not.toContain('secret-token');
    });

    test('should store mcaId on first save', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'test',
      });

      const doc = await db.collection('user_credentials').findOne({
        userId: testUserId,
        appId: testAppId,
      });

      expect(doc?.mcaId).toBe(testMcaId);
    });
  });

  describe('credential updates', () => {
    test('should update credentials partially', async () => {
      const userAuth = auth.forUser(testUserId);

      // Initial set
      await userAuth.app(testAppId).set({
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        email: 'test@example.com',
      });

      // Update only accessToken
      await userAuth.app(testAppId).update({
        accessToken: 'new-token',
      });

      const updated = await userAuth.app(testAppId).get();

      expect(updated.accessToken).toBe('new-token');
      expect(updated.refreshToken).toBe('refresh-token'); // Should still be there
      expect(updated.email).toBe('test@example.com'); // Should still be there
    });

    test('should set specific key', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
        email: 'test@example.com',
      });

      await userAuth.app(testAppId).setKey('accessToken', 'updated-token');

      const token = await userAuth.app(testAppId).getKey('accessToken');
      expect(token).toBe('updated-token');
    });

    test('should get specific key', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
        email: 'test@example.com',
      });

      const email = await userAuth.app(testAppId).getKey('email');
      expect(email).toBe('test@example.com');
    });

    test('should invalidate specific key', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
        refreshToken: 'refresh',
        email: 'test@example.com',
      });

      await userAuth.app(testAppId).invalidateKey('accessToken');

      const creds = await userAuth.app(testAppId).get();
      expect(creds.accessToken).toBeUndefined();
      expect(creds.refreshToken).toBe('refresh'); // Should still be there
    });
  });

  describe('credential revocation', () => {
    test('should revoke credentials', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
      });

      await userAuth.app(testAppId).revoke();

      const revoked = await userAuth.app(testAppId).get();
      expect(revoked).toBeUndefined();
    });

    test('should not list revoked apps', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
      });

      let apps = await userAuth.listApps();
      expect(apps).toContain(testAppId);

      await userAuth.app(testAppId).revoke();

      apps = await userAuth.listApps();
      expect(apps).not.toContain(testAppId);
    });
  });

  describe('listing', () => {
    test('should list all apps with credentials', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({ accessToken: 'token' });

      const apps = await userAuth.listApps();
      expect(apps).toContain(testAppId);
    });

    test('should list apps by MCA', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({ accessToken: 'token' });

      const gmailApps = await userAuth.listByMCA(testMcaId);
      expect(gmailApps).toContain(testAppId);
    });
  });

  describe('existence checks', () => {
    test('should check if credentials exist', async () => {
      const userAuth = auth.forUser(testUserId);

      let exists = await userAuth.app(testAppId).has();
      expect(exists).toBe(false);

      await userAuth.app(testAppId).set({ accessToken: 'token' });

      exists = await userAuth.app(testAppId).has();
      expect(exists).toBe(true);
    });

    test('should check if specific key exists', async () => {
      const userAuth = auth.forUser(testUserId);

      await userAuth.app(testAppId).set({
        accessToken: 'token',
        email: 'test@example.com',
      });

      const hasEmail = await userAuth.app(testAppId).hasKey('email');
      const hasRefresh = await userAuth.app(testAppId).hasKey('refreshToken');

      expect(hasEmail).toBe(true);
      expect(hasRefresh).toBe(false);
    });
  });

  describe('per-user encryption', () => {
    test('should create unique encryption key per user', async () => {
      const user1 = auth.forUser('user-1');
      const user2 = auth.forUser('user-2');

      // Both users store same credentials
      await user1.app(testAppId).set({ accessToken: 'token' });
      await user2.app(testAppId).set({ accessToken: 'token' });

      // But encryption should be different
      const doc1 = await db.collection('user_credentials').findOne({
        userId: 'user-1',
        appId: testAppId,
      });

      const doc2 = await db.collection('user_credentials').findOne({
        userId: 'user-2',
        appId: testAppId,
      });

      expect(doc1?.encryptedData).not.toBe(doc2?.encryptedData);

      // Cleanup
      await db.collection('user_credentials').deleteMany({
        userId: { $in: ['user-1', 'user-2'] },
      });
      await db.collection('user_encryption_keys').deleteMany({
        userId: { $in: ['user-1', 'user-2'] },
      });
    });
  });
});
