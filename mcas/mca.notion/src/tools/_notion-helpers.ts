/**
 * Notion-specific extractors.
 *
 * The Notion API returns deeply nested objects with annotations, formula
 * unwrapping, relation ID arrays, and many property types. These helpers
 * collapse them into flat camelCase shapes that the renderer can consume
 * without intermediate parsing.
 *
 * Rich text default: drop annotations (bold/italic/colour/code) and return
 * plain_text concatenation. Agents that need formatting must pass
 * includeRaw=true at the tool level.
 *
 * SDK v5 + API 2026-03-11 contract:
 *   - `archived` was renamed to `in_trash` on pages/blocks/databases. The
 *     extractors read `in_trash` first and fall back to `archived` so curated
 *     responses still expose the canonical `inTrash` boolean even on legacy
 *     payloads.
 *   - `transcription` block type was renamed to `meeting_notes`. Both are
 *     handled.
 *   - `parent.type` may now be `data_source_id` (v5 multi-source DBs) in
 *     addition to the existing variants.
 *   - `place` property type is supported (v5.4+).
 */

// ============================================================================
// UUID VALIDATION
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Same digits as UUID_RE but unanchored, for pulling an id out of a URL. */
const EMBEDDED_ID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

/** Re-hyphenate a bare (or partially dashed) 32-hex id into canonical 8-4-4-4-12. */
function toDashedUuid(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function validateUuid(id: string, label: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: expected UUID, got "${id}"`);
  }
  return id;
}

/**
 * Accepts either a raw Notion id (dashed UUID or the 32-hex form Notion uses in
 * URLs) OR a full Notion share URL, and returns the canonical dashed UUID.
 *
 * Why this exists (TER-369): users paste links straight from Notion's "Copy
 * link" button. `validateUuid` rejected those outright, so the agent had to be
 * told to hand-extract the id. Notion encodes the object id as the LAST 32-hex
 * run in the URL path; the `?v=<view-id>` query holds a *different* id (the
 * table view), so we strip the query/hash before scanning to avoid grabbing the
 * view id instead of the page/database id.
 *
 * Note on page-vs-database links: a database opened inline still has its own
 * link (the one carrying `?v=…`) — that's the one to paste for database tools.
 * The parent *page* link resolves to the page id, not the database, so the tool
 * descriptions tell the agent which link to use.
 */
export function resolveNotionId(input: string, label: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`Invalid ${label}: expected a Notion id or URL, got "${input}"`);
  }
  const trimmed = input.trim();

  // Fast path — already a bare id (dashed UUID or 32-hex).
  if (UUID_RE.test(trimmed)) return toDashedUuid(trimmed);

  // URL / pasted text — take the last id-shaped run in the path.
  const path = trimmed.split(/[?#]/)[0];
  const matches = path.match(EMBEDDED_ID_RE);
  if (matches && matches.length > 0) {
    return toDashedUuid(matches[matches.length - 1]);
  }

  throw new Error(
    `Invalid ${label}: expected a Notion id or share URL, got "${input}". ` +
      'For a database, paste its table link (the one with ?v=…) or its 32-char id — not the parent page link.',
  );
}

// ============================================================================
// RICH TEXT
// ============================================================================

export interface RichTextSegment {
  plain_text?: string;
  text?: { content?: string };
}

export function extractPlainText(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((seg: RichTextSegment) => (typeof seg?.plain_text === 'string' ? seg.plain_text : ''))
    .join('');
}

// ============================================================================
// ICON / COVER
// ============================================================================

export interface NormalisedIcon {
  type: 'emoji' | 'external' | 'file';
  value: string;
}

export function extractIcon(icon: any): NormalisedIcon | null {
  if (!icon) return null;
  if (icon.type === 'emoji' && typeof icon.emoji === 'string') {
    return { type: 'emoji', value: icon.emoji };
  }
  if (icon.type === 'external' && icon.external?.url) {
    return { type: 'external', value: icon.external.url };
  }
  if (icon.type === 'file' && icon.file?.url) {
    return { type: 'file', value: icon.file.url };
  }
  return null;
}

export interface NormalisedCover {
  type: 'external' | 'file';
  value: string;
}

export function extractCover(cover: any): NormalisedCover | null {
  if (!cover) return null;
  if (cover.type === 'external' && cover.external?.url) {
    return { type: 'external', value: cover.external.url };
  }
  if (cover.type === 'file' && cover.file?.url) {
    return { type: 'file', value: cover.file.url };
  }
  return null;
}

// ============================================================================
// PARENT
// ============================================================================

export interface NormalisedParent {
  parentType: 'page' | 'database' | 'data_source' | 'block' | 'workspace' | 'unknown';
  parentId: string | null;
  /**
   * For pages whose parent is a `data_source_id` (v5 multi-source DBs), the
   * containing database id is also exposed so the renderer / agent can still
   * call `query-database` with a databaseId.
   */
  databaseId?: string | null;
}

export function extractParent(parent: any): NormalisedParent {
  if (!parent || typeof parent !== 'object') {
    return { parentType: 'unknown', parentId: null };
  }
  switch (parent.type) {
    case 'page_id':
      return { parentType: 'page', parentId: parent.page_id ?? null };
    case 'database_id':
      return { parentType: 'database', parentId: parent.database_id ?? null };
    case 'data_source_id':
      return {
        parentType: 'data_source',
        parentId: parent.data_source_id ?? null,
        databaseId: parent.database_id ?? null,
      };
    case 'block_id':
      return { parentType: 'block', parentId: parent.block_id ?? null };
    case 'workspace':
      return { parentType: 'workspace', parentId: null };
    default:
      return { parentType: 'unknown', parentId: null };
  }
}

// ============================================================================
// PROPERTY EXTRACTION (the big one)
// ============================================================================

/**
 * Extracts a single Notion property value into a flat JS primitive.
 * Covers the 25+ property types. Returns null for unknown types.
 */
export function extractPropertyValue(prop: any): any {
  if (!prop || typeof prop !== 'object') return null;

  switch (prop.type) {
    case 'title':
      return extractPlainText(prop.title);
    case 'rich_text':
      return extractPlainText(prop.rich_text);
    case 'number':
      return prop.number ?? null;
    case 'checkbox':
      return !!prop.checkbox;
    case 'url':
      return prop.url ?? null;
    case 'email':
      return prop.email ?? null;
    case 'phone_number':
      return prop.phone_number ?? null;
    case 'select':
      return prop.select?.name ?? null;
    case 'status':
      return prop.status?.name ?? null;
    case 'multi_select':
      return Array.isArray(prop.multi_select)
        ? prop.multi_select.map((s: any) => s?.name).filter(Boolean)
        : [];
    case 'date':
      return prop.date
        ? {
            start: prop.date.start ?? null,
            end: prop.date.end ?? null,
            timeZone: prop.date.time_zone ?? null,
          }
        : null;
    case 'people':
      return Array.isArray(prop.people)
        ? prop.people.map((p: any) => ({ id: p?.id, name: p?.name ?? null }))
        : [];
    case 'files':
      return Array.isArray(prop.files)
        ? prop.files.map((f: any) => ({
            name: f?.name ?? null,
            url: f?.external?.url ?? f?.file?.url ?? null,
          }))
        : [];
    case 'relation':
      return Array.isArray(prop.relation)
        ? prop.relation.map((r: any) => r?.id).filter(Boolean)
        : [];
    case 'rollup':
      if (!prop.rollup) return null;
      if (prop.rollup.type === 'number') return prop.rollup.number ?? null;
      if (prop.rollup.type === 'date') return prop.rollup.date?.start ?? null;
      if (prop.rollup.type === 'array')
        return Array.isArray(prop.rollup.array) ? prop.rollup.array.map(extractPropertyValue) : [];
      return null;
    case 'formula':
      if (!prop.formula) return null;
      if (prop.formula.type === 'string') return prop.formula.string ?? null;
      if (prop.formula.type === 'number') return prop.formula.number ?? null;
      if (prop.formula.type === 'boolean') return prop.formula.boolean ?? null;
      if (prop.formula.type === 'date') return prop.formula.date?.start ?? null;
      return null;
    case 'created_time':
      return prop.created_time ?? null;
    case 'last_edited_time':
      return prop.last_edited_time ?? null;
    case 'created_by':
      return prop.created_by
        ? { id: prop.created_by.id, name: prop.created_by.name ?? null }
        : null;
    case 'last_edited_by':
      return prop.last_edited_by
        ? { id: prop.last_edited_by.id, name: prop.last_edited_by.name ?? null }
        : null;
    case 'unique_id':
      return prop.unique_id
        ? {
            number: prop.unique_id.number ?? null,
            prefix: prop.unique_id.prefix ?? null,
          }
        : null;
    case 'verification':
      return prop.verification
        ? {
            state: prop.verification.state ?? null,
            verifiedBy: prop.verification.verified_by?.id ?? null,
            date: prop.verification.date?.start ?? null,
          }
        : null;
    case 'place':
      // v5.4 added the place property. We expose lat/lon/name + the
      // human-readable address so the renderer can show "📍 Address" without
      // having to round-trip the LatLng.
      return prop.place
        ? {
            lat: prop.place.lat ?? null,
            lon: prop.place.lon ?? null,
            name: prop.place.name ?? null,
            address: prop.place.address ?? null,
          }
        : null;
    case 'button':
      return null;
    default:
      return null;
  }
}

/**
 * Extracts a whole properties object into a flat { name: value } map.
 *
 * Default (whitelist undefined or []): only the title is returned — keeps
 * `query-database` responses tight. Pass a concrete whitelist like
 * `['Status']` to also include those; pass `['*']` to include everything.
 * The title column is always kept so rows remain identifiable.
 */
export function extractProperties(
  rawProperties: Record<string, any> | undefined,
  whitelist?: string[],
): Record<string, any> {
  if (!rawProperties) return {};
  const result: Record<string, any> = {};
  const wl = new Set(whitelist ?? []);
  const includeAll = wl.has('*');

  for (const [key, raw] of Object.entries(rawProperties)) {
    const isTitle = raw?.type === 'title';
    if (includeAll || wl.has(key) || isTitle) {
      result[key] = extractPropertyValue(raw);
    }
  }

  // Guarantee that every explicitly whitelisted column appears in the
  // response — even when Notion's row doesn't include that key (happens
  // when the column was added after the row, or certain edge cases where
  // Notion omits empty cells). Returns null for the missing ones so the
  // caller can always rely on `row.properties.Status` instead of having
  // to check `'Status' in row.properties`.
  if (!includeAll) {
    for (const key of wl) {
      if (key !== '*' && !(key in result)) {
        result[key] = null;
      }
    }
  }

  return result;
}

// ============================================================================
// CANONICAL SHAPE EXTRACTORS
// ============================================================================

export function extractPageShape(page: any): Record<string, any> {
  if (!page || page.object !== 'page') return { id: page?.id };
  const title = findTitle(page.properties);
  const parent = extractParent(page.parent);
  const inTrash = readInTrash(page);
  return {
    id: page.id,
    object: 'page',
    url: page.url ?? null,
    title,
    icon: extractIcon(page.icon),
    cover: extractCover(page.cover),
    createdTime: page.created_time ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    databaseId: parent.databaseId ?? null,
    inTrash,
    /** @deprecated kept for backwards compatibility — prefer `inTrash`. */
    archived: inTrash,
    // By default the page shape carries *all* properties — `get-page`,
    // `create-page`, `update-page`, etc. want the full record. List tools
    // (`query-database`) override this with their own whitelist to keep
    // responses small.
    properties: extractProperties(page.properties, ['*']),
  };
}

export function extractDatabaseShape(db: any): Record<string, any> {
  if (!db || db.object !== 'database') return { id: db?.id };
  const parent = extractParent(db.parent);
  const inTrash = readInTrash(db);
  const dataSources: Array<{ id: string; name?: string }> = Array.isArray(db.data_sources)
    ? db.data_sources.map((ds: any) => ({ id: ds.id, name: ds.name ?? null }))
    : [];
  return {
    id: db.id,
    object: 'database',
    url: db.url ?? null,
    title: extractPlainText(db.title),
    description: extractPlainText(db.description),
    icon: extractIcon(db.icon),
    cover: extractCover(db.cover),
    createdTime: db.created_time ?? null,
    lastEditedTime: db.last_edited_time ?? null,
    parentType: parent.parentType,
    parentId: parent.parentId,
    inTrash,
    /** @deprecated kept for backwards compatibility — prefer `inTrash`. */
    archived: inTrash,
    isInline: !!db.is_inline,
    dataSources,
    isMultiSource: dataSources.length > 1,
    schema: extractSchema(db.properties),
  };
}

export function extractSearchResultShape(item: any): Record<string, any> {
  if (item?.object === 'database') return extractDatabaseShape(item);
  if (item?.object === 'page') {
    const shape = extractPageShape(item);
    delete shape.properties;
    return shape;
  }
  return { id: item?.id, object: item?.object ?? 'unknown' };
}

export function extractBlockShape(block: any): Record<string, any> {
  if (!block || !block.id) return { id: block?.id };
  const parent = extractParent(block.parent);
  const type = block.type;
  const body = type ? block[type] : undefined;
  const inTrash = readInTrash(block);

  const shape: Record<string, any> = {
    id: block.id,
    type,
    hasChildren: !!block.has_children,
    createdTime: block.created_time ?? null,
    lastEditedTime: block.last_edited_time ?? null,
    inTrash,
    /** @deprecated prefer `inTrash`. */
    archived: inTrash,
    parentType: parent.parentType,
    parentId: parent.parentId,
  };

  if (body && typeof body === 'object') {
    if (Array.isArray(body.rich_text)) {
      shape.plainText = extractPlainText(body.rich_text);
    }
    if (typeof body.language === 'string') shape.language = body.language;
    if (typeof body.checked === 'boolean') shape.checked = body.checked;
    if (Array.isArray(body.caption)) shape.caption = extractPlainText(body.caption);
    if (body.external?.url) shape.url = body.external.url;
    else if (body.file?.url) shape.url = body.file.url;
  }

  // meeting_notes (renamed from `transcription` on 2026-03-11). Surface the
  // summary text + a hint that a transcript is available — agents need
  // `get-page-markdown` with includeTranscript to retrieve the full text.
  if (type === 'meeting_notes' && body && typeof body === 'object') {
    shape.summary = Array.isArray(body.summary) ? extractPlainText(body.summary) : null;
    shape.hasTranscript = Array.isArray(body.transcript) && body.transcript.length > 0;
  }

  return shape;
}

export function extractUserShape(user: any): Record<string, any> {
  if (!user) return { id: null };
  return {
    id: user.id,
    name: user.name ?? null,
    type: user.type ?? null,
    avatarUrl: user.avatar_url ?? null,
    email: user.person?.email ?? null,
    bot: user.type === 'bot',
  };
}

export function extractCommentShape(comment: any): Record<string, any> {
  if (!comment) return { id: null };
  const parent = extractParent(comment.parent);
  return {
    id: comment.id,
    pageId: parent.parentType === 'page' ? parent.parentId : null,
    parentBlockId: parent.parentType === 'block' ? parent.parentId : null,
    discussionId: comment.discussion_id ?? null,
    authorId: comment.created_by?.id ?? null,
    plainText: extractPlainText(comment.rich_text),
    createdTime: comment.created_time ?? null,
    lastEditedTime: comment.last_edited_time ?? null,
  };
}

// ============================================================================
// INTERNALS
// ============================================================================

/**
 * Reads the trashed/archived state from a Notion object. API 2026-03-11
 * renamed `archived` to `in_trash`; the SDK still surfaces `archived` for
 * older versions and `false` payloads. We accept either.
 */
function readInTrash(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.in_trash === 'boolean') return obj.in_trash;
  if (typeof obj.archived === 'boolean') return obj.archived;
  return false;
}

function findTitle(properties: any): string {
  if (!properties || typeof properties !== 'object') return '';
  for (const prop of Object.values(properties)) {
    const p = prop as any;
    if (p?.type === 'title') return extractPlainText(p.title);
  }
  return '';
}

function extractSchema(properties: any): Record<string, { type: string; name?: string }> {
  if (!properties || typeof properties !== 'object') return {};
  const schema: Record<string, { type: string; name?: string }> = {};
  for (const [key, val] of Object.entries(properties)) {
    const p = val as any;
    if (p?.type) schema[key] = { type: p.type, name: p.name ?? key };
  }
  return schema;
}

// ============================================================================
// BLOCK SANITISATION (for writes: remove null fields Notion rejects on PATCH/POST)
// ============================================================================

/**
 * Strips null and undefined values from a block body so Notion's
 * `PATCH /blocks/:id` and `POST /blocks/:id/children` accept it. The Notion
 * API returns `icon: null` / `cover: null` on blocks that don't have them,
 * but rejects those same nulls on writes with:
 *   `body.paragraph.icon should be an object or 'undefined', instead was 'null'`
 */
function stripNulls<T extends Record<string, any>>(body: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Takes a raw block object as returned by `blocks.retrieve` and reshapes it
 * into the payload shape Notion accepts on `append` — `{ object: 'block', type,
 * [type]: <body-without-nulls> }`. Drops metadata Notion computes server-side
 * (id, timestamps, parent, created_by, has_children, archived, object wrapper).
 */
export function sanitiseBlockForAppend(block: any): any | null {
  if (!block || typeof block !== 'object') return null;
  const type = block.type as string | undefined;
  if (!type) return null;
  const body = block[type];
  if (!body || typeof body !== 'object') {
    return { object: 'block', type, [type]: {} };
  }
  return { object: 'block', type, [type]: stripNulls(body) };
}

/**
 * Same idea as `sanitiseBlockForAppend` but for the `PATCH /blocks/:id` body
 * which is `{ [type]: body }` — no wrapper, no object/type fields.
 */
export function sanitiseBlockForUpdate(
  type: string,
  body: Record<string, any>,
): Record<string, any> {
  return { [type]: stripNulls(body) };
}

// ============================================================================
// BLOCK TRIMMING (for get-page-content / get-block-children deep trees)
// ============================================================================

export interface TrimBlocksOptions {
  maxDepth?: number;
  maxChars?: number;
}

/**
 * Caps block tree depth and total serialised size. Used when responding with
 * raw blocks (e.g. get-blocks debug mode). Returns a shallow copy — original
 * blocks are not mutated.
 */
export function trimBlocks(blocks: any[], opts: TrimBlocksOptions = {}): any[] {
  const maxDepth = opts.maxDepth ?? 2;
  const maxChars = opts.maxChars ?? 10_000;
  let runningChars = 0;

  function walk(items: any[], depth: number): any[] {
    if (depth > maxDepth || runningChars >= maxChars) return [];
    const out: any[] = [];
    for (const b of items) {
      const serialised = JSON.stringify(b) ?? '';
      if (runningChars + serialised.length > maxChars) break;
      runningChars += serialised.length;
      const clone = { ...b };
      if (Array.isArray(b.children) && b.children.length > 0) {
        clone.children = walk(b.children, depth + 1);
      }
      out.push(clone);
    }
    return out;
  }

  return walk(blocks, 0);
}
