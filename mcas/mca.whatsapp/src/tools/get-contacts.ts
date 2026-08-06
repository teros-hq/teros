import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';
import { enrichWithPictures } from '../lib/pictures';

export const getContacts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get all contacts from a WhatsApp session.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      limit: {
        type: 'number',
        description: 'Max contacts to return (default: 50, max: 200)',
      },
      offset: {
        type: 'number',
        description: 'Number of contacts to skip for pagination (default: 0)',
      },
    },
  },
  handler: async (args) => {
    const { session = 'default', limit = 50, offset = 0 } = args as {
      session?: string;
      limit?: number;
      offset?: number;
    };
    const effectiveLimit = Math.min(limit, 200);
    // Correct WAHA endpoint for GOWS: GET /api/contacts/all?session=NAME
    // The old /{session}/contacts path returns 404 on GOWS engine.
    // WAHA /contacts/all does not support native pagination, so we fetch all
    // and paginate client-side, sorted alphabetically by name.
    const params = new URLSearchParams({ session });
    const res = await wahaFetch(`/contacts/all?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    const all = await res.json();
    const allContacts = Array.isArray(all) ? all : [];
    // Sort alphabetically by name (pushName > name > id)
    allContacts.sort((a: Record<string, string>, b: Record<string, string>) => {
      const nameA = (a.pushName ?? a.name ?? a.id ?? '').toLowerCase();
      const nameB = (b.pushName ?? b.name ?? b.id ?? '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    const page = allContacts.slice(offset, offset + effectiveLimit);

    // Enrich contacts with their profile picture (parallel, best-effort)
    const enriched = await enrichWithPictures(page, (c) => c.id as string, session);

    return {
      contacts: enriched,
      total: allContacts.length,
      limit: effectiveLimit,
      offset,
      hasMore: offset + effectiveLimit < allContacts.length,
    };
  },
};
