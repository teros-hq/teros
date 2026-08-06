import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

interface WahaChat {
  id: string;
  name?: string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  lastMessage?: {
    body?: string;
    timestamp?: number;
    [key: string]: unknown;
  };
  conversationTimestamp?: number;
  _chat?: Record<string, unknown>;
  [key: string]: unknown;
}

export const getUnreadChats: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Return chats that have unread messages, ordered by unread count (desc). Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      limit: {
        type: 'number',
        description: 'Max chats to return per page (default: 20)',
      },
      offset: {
        type: 'number',
        description: 'Number of chats to skip for pagination (default: 0)',
      },
    },
  },
  handler: async (args) => {
    const { session = 'default', limit = 20, offset = 0 } = args as {
      session?: string;
      limit?: number;
      offset?: number;
    };

    const effectiveLimit = Math.min(limit, 100);

    // ── Fetch all chats (large batch to filter client-side) ─────────────────
    // WAHA doesn't expose a native "unread only" filter, so we fetch a large
    // page sorted by conversationTimestamp and filter client-side.
    const params = new URLSearchParams({
      limit: '200',
      offset: '0',
      sortBy: 'conversationTimestamp',
      sortOrder: 'desc',
    });
    const res = await wahaFetch(`/${session}/chats?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        success: false,
        status: res.status,
        error: `WAHA returned HTTP ${res.status}`,
        detail: err,
      };
    }

    const allChats: WahaChat[] = await res
      .json()
      .then((d) => (Array.isArray(d) ? d : []));

    // ── Filter: only chats with unread messages ─────────────────────────────
    // Check top-level unreadCount or nested inside _chat (engine raw data)
    const unread = allChats.filter((c) => {
      const raw = c._chat ?? {};
      const count =
        typeof c.unreadCount === 'number' ? c.unreadCount :
        typeof raw.unreadCount === 'number' ? raw.unreadCount : 0;
      return count > 0;
    });

    // ── Sort by unreadCount DESC, then by lastMessage timestamp DESC ─────────
    unread.sort((a, b) => {
      const rawA = a._chat ?? {};
      const rawB = b._chat ?? {};
      const countA =
        typeof a.unreadCount === 'number' ? a.unreadCount :
        typeof rawA.unreadCount === 'number' ? rawA.unreadCount : 0;
      const countB =
        typeof b.unreadCount === 'number' ? b.unreadCount :
        typeof rawB.unreadCount === 'number' ? rawB.unreadCount : 0;
      const countDiff = countB - countA;
      if (countDiff !== 0) return countDiff;
      const tsA =
        a.lastMessage?.timestamp ?? a.conversationTimestamp ?? 0;
      const tsB =
        b.lastMessage?.timestamp ?? b.conversationTimestamp ?? 0;
      return (tsB as number) - (tsA as number);
    });

    const total = unread.length;
    const page = unread.slice(offset, offset + effectiveLimit);

    // ── Shape the output (same normalization as get-chats) ───────────────────
    const chats = page.map((c) => {
      const raw = c._chat ?? {};

      const unreadCount =
        typeof c.unreadCount === 'number' ? c.unreadCount :
        typeof raw.unreadCount === 'number' ? raw.unreadCount : 0;

      const archived =
        typeof c.archived === 'boolean' ? c.archived :
        typeof raw.archived === 'boolean' ? raw.archived :
        typeof raw.archive === 'boolean' ? raw.archive : false;

      const pinned =
        typeof c.pinned === 'boolean' ? c.pinned :
        typeof raw.pinned === 'boolean' ? raw.pinned :
        typeof raw.pin === 'boolean' ? raw.pin : false;

      const ts =
        c.lastMessage?.timestamp ?? c.conversationTimestamp ?? null;
      const lastMessageAt =
        ts != null ? new Date((ts as number) * 1000).toISOString() : null;

      return {
        id: c.id,
        name: c.name ?? c.id.split('@')[0] ?? c.id,
        unreadCount,
        isUnread: unreadCount > 0,
        archived,
        pinned,
        lastMessage: c.lastMessage
          ? {
              text: (c.lastMessage.body as string | undefined) ?? null,
              timestamp: lastMessageAt,
            }
          : null,
        lastMessageAt,
      };
    });

    return {
      chats,
      total,
      offset,
      limit: effectiveLimit,
      hasMore: offset + effectiveLimit < total,
    };
  },
};
