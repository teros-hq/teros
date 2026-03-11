#!/usr/bin/env bun

/**
 * Seed Test Data for E2E Tests
 *
 * Seeds the E2E test database with users, agents, and models.
 * Run this before executing E2E tests.
 *
 * Usage: bun src/scripts/seed-test-data.ts
 */

import { hash } from 'bcrypt';
import { MongoClient, ObjectId } from 'mongodb';
import { E2E_CONFIG, TEST_AGENTS, TEST_MODELS, TEST_USERS } from '../fixtures/test-data';

async function seed() {
  console.log('🌱 Seeding E2E test database...');
  console.log(`   MongoDB: ${E2E_CONFIG.mongoUri}`);
  console.log(`   Database: ${E2E_CONFIG.dbName}`);

  const client = new MongoClient(E2E_CONFIG.mongoUri);

  try {
    await client.connect();
    const db = client.db(E2E_CONFIG.dbName);

    // Clear existing data
    console.log('\n🧹 Clearing existing data...');
    await db.collection('users').deleteMany({});
    await db.collection('user_identities').deleteMany({});
    await db.collection('agents').deleteMany({});
    await db.collection('models').deleteMany({});
    await db.collection('channels').deleteMany({});
    await db.collection('messages').deleteMany({});

    const now = new Date();

    // Seed users (matching the real schema)
    console.log('\n👤 Seeding users...');
    for (const [key, user] of Object.entries(TEST_USERS)) {
      const userId = `user_${key}`;
      const passwordHash = await hash(user.password, 10);

      // Create user document (matches User type)
      await db.collection('users').insertOne({
        _id: new ObjectId(),
        userId,
        profile: {
          displayName: user.name,
          email: user.email.toLowerCase(),
        },
        status: 'active',
        role: user.role,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      // Create identity document for password auth
      // NOTE: The field is "type" not "provider" based on identity-service.ts
      await db.collection('user_identities').insertOne({
        _id: new ObjectId(),
        userId,
        type: 'password', // Changed from 'provider' to 'type'
        providerUserId: user.email.toLowerCase(),
        data: {
          passwordHash,
          failedAttempts: 0,
        },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      console.log(`   ✓ ${user.email} (${userId})`);
    }

    // Seed models
    console.log('\n🤖 Seeding models...');
    for (const [key, model] of Object.entries(TEST_MODELS)) {
      await db.collection('models').insertOne({
        _id: model.id,
        name: model.name,
        provider: model.provider,
        modelId: model.modelId,
        maxTokens: model.maxTokens,
        contextWindow: model.contextWindow,
        isDefault: model.isDefault,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`   ✓ ${model.name}`);
    }

    // Seed agents
    console.log('\n🤖 Seeding agents...');
    for (const [key, agent] of Object.entries(TEST_AGENTS)) {
      await db.collection('agents').insertOne({
        _id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        modelId: agent.modelId,
        isPublic: agent.isPublic,
        ownerId: (agent as any).ownerId,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`   ✓ ${agent.name}`);
    }

    console.log('\n✅ Seed completed successfully!');
    console.log(`\n📊 Summary:`);
    console.log(`   Users: ${Object.keys(TEST_USERS).length}`);
    console.log(`   Models: ${Object.keys(TEST_MODELS).length}`);
    console.log(`   Agents: ${Object.keys(TEST_AGENTS).length}`);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
