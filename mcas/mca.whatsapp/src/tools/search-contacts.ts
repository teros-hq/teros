import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

interface WahaContact {
  id: string;
  name?: string;
  pushName?: string;
  [key: string]: unknown;
}

interface WahaChat {
  id: string;
  lastMessage?: {
    timestamp?: number;
    [key: string]: unknown;
  };
  conversationTimestamp?: number;
  [key: string]: unknown;
}

export const searchContacts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search contacts by name or phone number. Returns matches ordered by most recent interaction first (top 5), then remaining matches up to limit.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      query: {
        type: 'string',
        description:
          'Search term to match against contact name, pushName, or phone number (e.g. "antonio" or "346123")',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 20)',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const { session = 'default', query, limit = 20 } = args as {
      session?: string;
      query: string;
      limit?: number;
    };

    const effectiveLimit = Math.min(limit, 200);
    const lowerQuery = query.toLowerCase();

    // ── 1. Fetch all contacts ───────────────────────────────────────────────
    const contactsRes = await wahaFetch(`/contacts/all?session=${session}`);
    if (!contactsRes.ok) {
      const err = await contactsRes.json().catch(() => ({}));
      return {
        success: false,
        status: contactsRes.status,
        error: `WAHA returned HTTP ${contactsRes.status}`,
        detail: err,
      };
    }
    const allContacts: WahaContact[] = await contactsRes
      .json()
      .then((d) => (Array.isArray(d) ? d : []));

    // ── 2. Filter by query ──────────────────────────────────────────────────
    const matched = allContacts.filter((c) => {
      const name = (c.name ?? '').toLowerCase();
      const pushName = (c.pushName ?? '').toLowerCase();
      const id = (c.id ?? '').toLowerCase();
      return (
        name.includes(lowerQuery) ||
        pushName.includes(lowerQuery) ||
        id.includes(lowerQuery)
      );
    });

    if (matched.length === 0) {
      return { results: [], total: 0 };
    }

    // ── 3. Fetch chats to get lastMessage timestamps ────────────────────────
    const chatTimestampMap = new Map<string, number>();
    try {
      const chatsRes = await wahaFetch(
        `/${session}/chats?limit=100&offset=0&sortBy=conversationTimestamp&sortOrder=desc`
      );
      if (chatsRes.ok) {
        const chatsData: WahaChat[] = await chatsRes
          .json()
          .then((d) => (Array.isArray(d) ? d : []));
        for (const chat of chatsData) {
          const ts =
            chat.lastMessage?.timestamp ?? chat.conversationTimestamp ?? null;
          if (chat.id && ts != null) {
            chatTimestampMap.set(chat.id, ts as number);
          }
        }
      }
    } catch {
      // Non-fatal: proceed without timestamp ordering
    }

    // ── 4. Build result objects ─────────────────────────────────────────────
    type ContactResult = {
      id: string;
      name: string;
      number: string;
      lastMessageAt: string | null;
      _ts: number;
    };

    const results: ContactResult[] = matched.map((c) => {
      const ts = chatTimestampMap.get(c.id) ?? null;
      // WAHA timestamps are Unix seconds; convert to ISO
      const lastMessageAt =
        ts != null ? new Date(ts * 1000).toISOString() : null;
      // Extract numeric part: "34612345678@c.us" -> "34612345678"
      const number = c.id.split('@')[0] ?? c.id;
      const name = c.pushName ?? c.name ?? number;

      return { id: c.id, name, number, lastMessageAt, _ts: ts ?? 0 };
    });

    // ── 5. Sort: top 5 by timestamp DESC, rest appended unsorted ───────────
    const withTs = results
      .filter((r) => r._ts > 0)
      .sort((a, b) => b._ts - a._ts);
    const withoutTs = results.filter((r) => r._ts === 0);
    const sorted = [...withTs, ...withoutTs].slice(0, effectiveLimit);

    // Strip internal _ts field from output
    const output = sorted.map(({ _ts: _ignored, ...rest }) => rest);

    return { results: output, total: output.length };
  },
};
