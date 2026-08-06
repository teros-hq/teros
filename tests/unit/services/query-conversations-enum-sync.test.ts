/**
 * Drift guard: every `query_conversations` action that has a switch handler in
 * `mca-connection-manager.queries-*` MUST be a member of the protocol enum
 * `WsQueryConversationsActionSchema`. Otherwise the schema rejects the action
 * with "Invalid message format" before the handler can run — a silent timeout
 * the agent never recovers from (class TER-264; confirmed drift fixed in
 * TER-444: archive_project + the *_event_subscriptions actions).
 *
 * Direction is `switch ⊆ enum` only, NOT bidirectional: the enum may legitimately
 * be a superset because some actions (e.g. update_task_status) are served by the
 * parallel WsRouter/protocol path, not the MCA queries switch.
 *
 * The enum is imported from source (bun transpiles TS, so no dist build needed
 * and `.options` is the real runtime tuple — Zod 3 API). The switch handlers are
 * read from the source files so a new `queries-*.ts` is covered automatically.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WsQueryConversationsActionSchema } from '../../../packages/shared/src/mca-health';

const SERVICES_DIR = resolve(__dirname, '../../../packages/backend/src/services');

/** All action labels handled by a `case '<action>':` in the queries switches. */
function switchActions(): string[] {
  const files = readdirSync(SERVICES_DIR).filter(
    (f) => f.startsWith('mca-connection-manager.queries-') && f.endsWith('.ts'),
  );
  const actions = new Set<string>();
  for (const file of files) {
    const src = readFileSync(resolve(SERVICES_DIR, file), 'utf-8');
    for (const match of src.matchAll(/case\s+'([a-z_]+)'/g)) {
      actions.add(match[1]);
    }
  }
  return [...actions];
}

describe('query_conversations enum ↔ switch drift guard (TER-444)', () => {
  it('every action with a switch handler is in WsQueryConversationsActionSchema', () => {
    const handled = switchActions();
    // Guard against the glob/regex silently finding nothing and passing vacuously.
    expect(handled.length).toBeGreaterThan(40);

    const allowed = new Set<string>(WsQueryConversationsActionSchema.options);
    const missingFromEnum = handled.filter((a) => !allowed.has(a)).sort();

    expect(missingFromEnum).toEqual([]);
  });
});
