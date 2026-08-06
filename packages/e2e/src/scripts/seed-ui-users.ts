#!/usr/bin/env tsx
/**
 * Seed UI test users into the test MongoDB.
 *
 * Creates real password-authenticated users for Playwright UI tests.
 * Uses the same schema as the real backend (user-service + identity-service).
 *
 * Usage:
 *   tsx src/scripts/seed-ui-users.ts
 */

import bcrypt from 'bcrypt';
import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.E2E_MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.E2E_DB_NAME || 'teros_test';
const BCRYPT_ROUNDS = 10;

export const UI_TEST_USERS = [
  {
    userId: 'user_uitest_user',
    email: 'user@teros.ai',
    password: 'userpass',
    displayName: 'UI Test User',
    role: 'user',
  },
] as const;

async function seed() {
  console.log('🌱 Seeding UI test users...');
  console.log(`   MongoDB: ${MONGO_URI} / ${DB_NAME}`);

  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const now = new Date();

    for (const u of UI_TEST_USERS) {
      // Upsert user document
      await db.collection('users').updateOne(
        { userId: u.userId },
        {
          $set: {
            userId: u.userId,
            profile: {
              displayName: u.displayName,
              email: u.email.toLowerCase(),
              avatarUrl: null,
            },
            status: 'active',
            role: u.role,
            emailVerified: true,
            accessGranted: true,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdAt: now,
          },
        },
        { upsert: true },
      );

      // Upsert password identity
      const passwordHash = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
      await db.collection('user_identities').updateOne(
        { type: 'password', providerUserId: u.email.toLowerCase() },
        {
          $set: {
            userId: u.userId,
            type: 'password',
            providerUserId: u.email.toLowerCase(),
            email: u.email.toLowerCase(),
            data: {
              passwordHash,
              failedAttempts: 0,
              lastPasswordChangeAt: now,
            },
            status: 'active',
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdAt: now,
          },
        },
        { upsert: true },
      );

      console.log(`   ✓ ${u.email} (${u.userId})`);
    }

    console.log('✅ UI users seeded successfully');
  } finally {
    await client.close();
  }
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
