/**
 * Profile picture enrichment helper for mca.whatsapp tools.
 *
 * Fetches profilePictureURL for a list of items that have a chatId/contactId
 * field, attaching the result as `picture`. Runs in parallel, best-effort —
 * failures are silently ignored and the item is returned unchanged.
 *
 * Only enriches IDs in @c.us or @g.us format (phone/group JIDs).
 * @lid internal IDs are skipped — WAHA cannot resolve pictures for them.
 */

import { wahaFetch } from './api';

/**
 * Fetch profile picture URL for a single JID. Returns null on failure.
 */
async function fetchPicture(contactId: string, session: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ contactId, session });
    const res = await wahaFetch(`/contacts/profile-picture?${params}`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.profilePictureURL ?? data?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Enrich an array of objects with a `picture` field.
 *
 * @param items   Array of objects to enrich
 * @param getId   Function to extract the JID from each item
 * @param session WAHA session name
 */
export async function enrichWithPictures<T extends Record<string, unknown>>(
  items: T[],
  getId: (item: T) => string | undefined,
  session: string,
): Promise<T[]> {
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const id = getId(item);
      // Only @c.us (individual) and @g.us (group) IDs are resolvable
      if (!id || (!id.endsWith('@c.us') && !id.endsWith('@g.us'))) return item;
      const picture = await fetchPicture(id, session);
      return picture ? ({ ...item, picture } as T) : item;
    }),
  );

  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : items[i]));
}
