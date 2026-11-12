/**
 * Access flags seed for fresh environments (Railway entrypoint).
 *
 * This script upserts feature_flags documents BEFORE the backend boots.
 * The boot-time registry sync (FeatureFlagService.syncRegistry) never
 * overwrites an existing defaultValue, so the seeds stick across restarts.
 * Idempotent: safe to run on every container start.
 *
 * Flags seeded (gated by their own env var, none baked into the image):
 *   - access.auto-grant=true  (SEED_AUTO_GRANT=1)      — dev convenience:
 *     new signups skip the private-beta waitlist and land in the workspace
 *     directly. Dev-only: production keeps manual founder review.
 *
 * Multi-user workspaces no longer need a flag: `muw.enabled` was retired on
 * 2026-11-02 (MUW is always on) and migration 20261102_001 drops the document.
 *
 * Usage: SEED_AUTO_GRANT=1 node seed-flags.mjs
 * Env:   MONGODB_URI, MONGODB_DATABASE (default "teros")
 */

import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "teros";

if (!uri) {
  console.error("[seed-flags] MONGODB_URI is not set");
  process.exit(1);
}

const now = new Date().toISOString();

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const col = client.db(dbName).collection("feature_flags");

  if (process.env.SEED_AUTO_GRANT === "1") {
    const result = await col.updateOne(
      { key: "access.auto-grant" },
      {
        $set: {
          key: "access.auto-grant",
          type: "boolean",
          defaultValue: true,
          description:
            "Automatically grant platform access to new users on sign-up. When enabled, users skip the private beta waitlist and go straight to the welcome/terms screen.",
          category: "access",
          updatedAt: now,
          syncedAt: now,
          seededBy: "docker/railway/seed-flags.mjs",
        },
      },
      { upsert: true },
    );

    console.log(
      `[seed-flags] access.auto-grant defaultValue=true ${result.upsertedId ? "(created)" : "(updated)"} on ${dbName}`,
    );
  }
} finally {
  await client.close();
}
