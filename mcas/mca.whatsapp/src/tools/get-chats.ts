import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';
import { enrichWithPictures } from '../lib/pictures';

export const getChats: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List all WhatsApp chats (conversations) in a session.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      limit: {
        type: 'number',
        description: 'Max chats to return (default: 20)',
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
    const params = new URLSearchParams({
      limit: String(effectiveLimit),
      offset: String(offset),
      sortBy: 'conversationTimestamp',
      sortOrder: 'desc',
    });
    const res = await wahaFetch(`/${session}/chats?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    const chats = await res.json();
    const items: Record<string, unknown>[] = Array.isArray(chats) ? chats : [];
    const enriched = await enrichWithPictures(items, (c) => c.id as string, session);

    // Normalize each chat: extract useful fields from top-level or _chat raw data
    const normalized = enriched.map((c: Record<string, unknown>) => {
      // WAHA may return these top-level or nested inside _chat (engine raw data)
      const raw = c._chat && typeof c._chat === 'object' ? (c._chat as Record<string, unknown>) : {};

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

      const ts = c.lastMessage && typeof (c.lastMessage as Record<string, unknown>).timestamp === 'number'
        ? (c.lastMessage as Record<string, unknown>).timestamp as number
        : typeof c.conversationTimestamp === 'number'
          ? c.conversationTimestamp
          : null;

      return {
        ...c,
        unreadCount,
        isUnread: unreadCount > 0,
        archived,
        pinned,
        lastMessageAt: ts != null ? new Date(ts * 1000).toISOString() : null,
      };
    });

    return {
      chats: normalized,
      total: normalized.length, // page size (WAHA doesn't return total count)
      limit: effectiveLimit,
      offset,
      hasMore: normalized.length === effectiveLimit,
    };
  },
};
