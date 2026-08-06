import { After, AfterAll, Before, BeforeAll, Status } from '@cucumber/cucumber';
import { MongoClient } from 'mongodb';
import { UI_TEST_USERS } from '../../src/scripts/seed-ui-users';
import type { UIWorld } from './world.ui';

// ── One-time setup: seed UI test users into the real backend DB ───────────────

BeforeAll(async () => {
  const uri = process.env.E2E_MONGO_URI || 'mongodb://localhost:27017';
  const dbName = process.env.E2E_DB_NAME || 'teros_test';

  console.log('🌱 Seeding UI test users...');

  // Dynamically import bcrypt so the module works in both bun and node
  const { default: bcrypt } = await import('bcrypt');
  const { ObjectId } = await import('mongodb');

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const now = new Date();

    for (const u of UI_TEST_USERS) {
      await db.collection('users').updateOne(
        { userId: u.userId },
        {
          $set: {
            userId: u.userId,
            profile: { displayName: u.displayName, email: u.email.toLowerCase(), avatarUrl: null },
            status: 'active',
            role: u.role,
            emailVerified: true,
            accessGranted: true,
            updatedAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), createdAt: now },
        },
        { upsert: true },
      );

      const passwordHash = await bcrypt.hash(u.password, 10);
      await db.collection('user_identities').updateOne(
        { type: 'password', providerUserId: u.email.toLowerCase() },
        {
          $set: {
            userId: u.userId,
            type: 'password',
            providerUserId: u.email.toLowerCase(),
            email: u.email.toLowerCase(),
            data: { passwordHash, failedAttempts: 0, lastPasswordChangeAt: now },
            status: 'active',
            updatedAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), createdAt: now },
        },
        { upsert: true },
      );

      console.log(`   ✓ ${u.email}`);
    }
  } finally {
    await client.close();
  }

  console.log('✅ UI test users ready');
});

// ── Per-scenario: open / close browser ───────────────────────────────────────

Before(async function (this: UIWorld) {
  this.client = null;
  this.lastResponse = null;
  this.channelId = null;
  this.sessionToken = null;
  this.userId = null;
  await this.openBrowser();
});

After(async function (this: UIWorld, scenario) {
  if (scenario.result?.status === Status.FAILED && this.page) {
    // Capture screenshot on failure for debugging
    const name = scenario.pickle.name.replace(/\s+/g, '-').toLowerCase();
    await this.page.screenshot({ path: `reports/screenshots/${name}-failed.png` });
    console.log(`❌ Scenario failed: ${scenario.pickle.name}`);
  }
  await this.closeBrowser();
  await this.cleanup();
});

AfterAll(async () => {
  // Nothing to tear down — backend and MongoDB are managed by docker compose
});
