import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { deleteMessages } from '../src/tools/delete-messages';
import { manageMembers } from '../src/tools/manage-members';
import { searchMessages } from '../src/tools/search-messages';
import { bootstrapEventForwarding, ensureEventForwarding, getEventStatus } from '../src/lib/events';

/**
 * Tool-level validation tests: parameter checks run BEFORE any Telegram
 * connection is attempted, so these exercise the guard rails without network.
 */

describe('delete-messages tool', () => {
  it('rejects an empty messageIds array without touching the client', async () => {
    const out = (await deleteMessages.handler({ chat: '@foo', messageIds: [] }, {} as never)) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain('messageIds');
  });

  it('rejects more than 100 message ids (Telegram limit)', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const out = (await deleteMessages.handler({ chat: '@foo', messageIds: ids }, {} as never)) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain('100');
  });
});

describe('manage-members tool', () => {
  it('requires a user for member actions other than list', async () => {
    const out = (await manageMembers.handler({ chat: '@foo', action: 'ban' }, {} as never)) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain('user is required');
  });
});

describe('search-messages tool', () => {
  it('requires a query', async () => {
    const out = (await searchMessages.handler({}, {} as never)) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain('query');
  });
});

describe('event forwarding bootstrap (native auto-start)', () => {
  it('is a safe no-op without a backend callback URL (no throw, stays inactive)', async () => {
    // Test env has no MCA_CALLBACK_URL — bootstrap must degrade gracefully.
    await bootstrapEventForwarding(null);
    const status = getEventStatus();
    expect(status.active).toBe(false);
  });

  it('ensureEventForwarding is idempotent and never throws', async () => {
    await ensureEventForwarding(null);
    await ensureEventForwarding(null);
    expect(getEventStatus().active).toBe(false);
  });

  it('exposes the telegram.* topics conversations/boards can subscribe to', () => {
    const status = getEventStatus();
    expect(status.topics).toContain('telegram.message.received');
    expect(status.topics).toContain('telegram.message.edited');
    expect(status.topics).toContain('telegram.message.deleted');
  });
});

describe('tool definitions', () => {
  it('all tools expose description and JSON-schema parameters', () => {
    for (const tool of [deleteMessages, manageMembers, searchMessages]) {
      expect(typeof tool.description).toBe('string');
      expect((tool.parameters as { type?: string }).type).toBe('object');
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('no manual event tools remain (forwarding is native)', () => {
    // events-start / events-status were removed — the watcher auto-starts at
    // boot. If someone re-adds them as tools, this test fails as a reminder.
    const toolsIndex = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf-8');
    expect(toolsIndex).not.toContain('events-tools');
    expect(toolsIndex).not.toContain('eventsStart');
  });
});
