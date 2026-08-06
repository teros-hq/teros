import type { Db } from 'mongodb';
import { config } from '../config';
import type { Migration } from './types.js';

/**
 * Normalize stored avatarUrl values to the canonical convention: a BARE filename
 * (e.g. "iria-avatar.jpg"). The backend resolves it to a public URL at the
 * output boundary via buildAvatarUrl() (TER-607).
 *
 * Background: an older upload path stored an ABSOLUTE URL in the DB
 * ("http://host/static/<file>"), and a non-idempotent resolver could double-wrap
 * it into "<base>/<base>/<file>" → 404. Storing the bare filename instead makes
 * resolution idempotent AND robust to host changes (dev↔prod), since the host is
 * derived from config.static.baseUrl at serve time, not frozen in the DB.
 *
 * Safe & conservative: only rewrites self-referential URLs (those containing
 * "/static/") down to their last path segment. Bare filenames and genuinely
 * external avatar URLs (no "/static/") are left untouched. Values with ':' (from
 * pre-sanitization uploads) are NOT rewritten here — the static server now
 * decodes percent-encoding (TER-608), so those serve correctly as-is, and the
 * on-disk file still carries the ':'. Idempotent: re-running is a no-op.
 */

/**
 * Reduce a self-referential static URL (one pointing at OUR static base) to its
 * bare filename. Leaves bare filenames and genuinely external URLs untouched —
 * an external CDN URL that merely contains '/static/' (e.g.
 * `https://cdn.com/static/x.png`) must NOT be truncated.
 *
 * Strips the base PREFIX (by length), not by splitting on '/static/', so it works
 * for ANY `STATIC_BASE_URL` shape (with/without a '/static' segment, with/without
 * a trailing slash). Loops to collapse a historical double-wrap (`base/base/file`).
 */
export function toBareAvatarFilename(value: string, staticBaseUrl: string): string {
  if (!staticBaseUrl || !value.startsWith(staticBaseUrl)) return value;
  let v = value;
  while (v.startsWith(staticBaseUrl)) {
    v = v.slice(staticBaseUrl.length).replace(/^\/+/, '');
  }
  return v || value;
}

const COLLECTIONS = ['agents', 'agent_cores'] as const;

const migration: Migration = {
  description:
    'Normalize avatarUrl to bare filename in agents + agent_cores (strip self-referential /static/ URLs; idempotent)',

  async up(db: Db): Promise<void> {
    const baseUrl = config.static.baseUrl;
    for (const name of COLLECTIONS) {
      const col = db.collection(name);
      // Escanear todos los avatarUrl string; toBareAvatarFilename decide cuáles son
      // self-referenciales (no filtramos por '/static/' en la query: STATIC_BASE_URL
      // puede no contener ese segmento).
      const cursor = col.find({ avatarUrl: { $type: 'string' } });
      let fixed = 0;
      for await (const doc of cursor) {
        const current = doc.avatarUrl as string;
        const bare = toBareAvatarFilename(current, baseUrl);
        if (bare && bare !== current) {
          await col.updateOne({ _id: doc._id }, { $set: { avatarUrl: bare } });
          fixed++;
        }
      }
      console.log(`[Migration] normalize_avatar_urls: ${name} → ${fixed} avatarUrl(s) reduced to bare filename`);
    }
  },

  // No down(): the original absolute URLs are not preserved, and the bare form is
  // strictly more correct (resolved at serve time). Reverting would reintroduce
  // the host-frozen double-wrap risk.
};

export default migration;
