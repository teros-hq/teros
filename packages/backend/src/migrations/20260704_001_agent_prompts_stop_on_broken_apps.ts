import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Migration } from './types.js';

/**
 * Re-sync both agent cores' system prompts from their prompt files.
 *
 * The prompt files gained the "stop on broken apps" guidance: when the app
 * behind a tool is itself broken (not authenticated, service down, correct
 * calls keep failing), the agent must report and stop instead of improvising
 * workarounds through unrelated tools (shell, scripts, direct API calls) or
 * asking the user for credentials/manual steps. Workarounds only on explicit
 * user request. `agent_cores.systemPrompt` is frozen in DB, so prompt-file
 * changes need this copy step (same pattern as 20260703_001).
 */
const CORES: Array<{ coreId: string; file: string }> = [
  { coreId: 'agent', file: 'base-agent-core.md' },
  { coreId: 'super-agent', file: 'base-super-agent-core.md' },
];

const migration: Migration = {
  description:
    "Update both agent cores' systemPrompt from their prompt files (adds the stop-on-broken-apps / no-improvised-workarounds guidance).",

  async up(db: Db): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));

    for (const { coreId, file } of CORES) {
      let prompt: string;
      try {
        prompt = readFileSync(join(here, '../prompts/', file), 'utf-8');
      } catch (err) {
        // NEVER replace an existing good prompt with a placeholder: if the
        // file can't be read, leave the core untouched and let a later boot
        // (with the file present) re-run cleanly.
        throw new Error(`Cannot read prompts/${file} — aborting prompt update: ${String(err)}`);
      }

      const res = await db.collection('agent_cores').updateOne(
        { coreId },
        { $set: { systemPrompt: prompt, updatedAt: new Date().toISOString() } },
      );
      console.log(
        `[Migration] ${coreId} systemPrompt ${res.modifiedCount ? 'updated' : 'unchanged (core missing or already current)'}`,
      );
    }
  },

  // No down(): the previous prompt text is not stored anywhere to restore from.
  // Reverting is an explicit product action (seed-agents or the admin
  // update-core handler), not a schema rollback.
};

export default migration;
