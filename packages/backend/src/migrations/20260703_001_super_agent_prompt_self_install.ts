import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Migration } from './types.js';

/**
 * Re-sync the super-agent core's system prompt from `prompts/base-super-agent-core.md`.
 *
 * The prompt file gained the "Extending your capabilities" section (self-install
 * apps from the catalog via list-catalog/install-app, gated by the tool-permission
 * `ask` flow), but `agent_cores.systemPrompt` was last written by the
 * consolidate-agent-cores migration, so existing environments never pick up
 * prompt-file changes. This copies the current file content into the core.
 */
const migration: Migration = {
  description:
    "Update the super-agent core's systemPrompt from prompts/base-super-agent-core.md (adds the self-install 'Extending your capabilities' guidance).",

  async up(db: Db): Promise<void> {
    let prompt: string;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      prompt = readFileSync(join(here, '../prompts/base-super-agent-core.md'), 'utf-8');
    } catch (err) {
      // Unlike the seed fallback, NEVER replace an existing good prompt with a
      // placeholder: if the file can't be read, leave the core untouched and
      // let a later boot (with the file present) re-run cleanly.
      throw new Error(
        `Cannot read prompts/base-super-agent-core.md — aborting prompt update: ${String(err)}`,
      );
    }

    const res = await db.collection('agent_cores').updateOne(
      { coreId: 'super-agent' },
      { $set: { systemPrompt: prompt, updatedAt: new Date().toISOString() } },
    );
    console.log(
      `[Migration] super-agent systemPrompt ${res.modifiedCount ? 'updated' : 'unchanged (core missing or already current)'}`,
    );
  },

  // No down(): the previous prompt text is not stored anywhere to restore from.
  // Reverting is an explicit product action (seed-agents or the admin
  // update-core handler), not a schema rollback.
};

export default migration;
