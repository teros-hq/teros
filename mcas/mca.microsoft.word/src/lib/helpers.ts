/**
 * Item addressing and response shaping.
 *
 * This file turns tool arguments into safe Graph item references. It builds no
 * requests and knows nothing about OOXML.
 */

/** Strips a leading slash so a path can be appended to a Graph root reference. */
export function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * Percent-encodes each path segment while preserving the separators.
 *
 * `#`, `?` and `%` are all legal in a OneDrive filename and all significant in
 * a URL: unencoded, `Reports/2026#final.docx` truncates at the fragment marker
 * and the request silently targets `Reports` instead (lesson 1).
 */
export function encodePathSegments(path: string): string {
  return normalizePath(path).split('/').map(encodeURIComponent).join('/');
}

/**
 * Resolves a tool's target to a Graph item reference.
 *
 * Throws when neither `itemId` nor `path` is supplied. Nothing validates
 * arguments before a handler runs — JSON Schema `required` is advisory in this
 * stack — so a typo'd name would otherwise fall through to a default and act on
 * the wrong item (lesson 4).
 */
export function itemRef(a: Record<string, unknown>): string {
  const itemId = typeof a.itemId === 'string' ? a.itemId.trim() : '';
  if (itemId) return `/me/drive/items/${encodeURIComponent(itemId)}`;

  const path = typeof a.path === 'string' ? a.path.trim() : '';
  if (path) return `/me/drive/root:/${encodePathSegments(path)}`;

  throw new Error('Specify itemId or path — the Word document to act on.');
}

/**
 * Appends an action segment to an item reference.
 *
 * Graph's path syntax terminates the path with `:` before a navigation
 * segment: `/me/drive/root:/Reports/Q3.docx:/content`. Without that
 * terminator Graph reads `content` as one more path segment and looks for an
 * item that does not exist, so every path-addressed call 404s while every
 * id-addressed one works — which is exactly why mocked tests never noticed.
 * Id-based refs take the segment directly.
 *
 * The two sibling apps in this suite bake the terminator into their `itemRef`
 * instead. Keeping it out of `itemRef` here means the bare item address stays
 * usable for a metadata read (`{ref}?$select=…`), which is the documented form
 * and would otherwise become `…/Q3.docx:?$select=…`.
 */
export function itemAction(ref: string, action: string): string {
  return ref.startsWith('/me/drive/root:/') ? `${ref}:${action}` : `${ref}${action}`;
}

/**
 * Rejects a name that is not a `.docx`.
 *
 * The extension is only half the check; `assertUsableDocx` in ooxml.ts inspects
 * the bytes. Both exist because either alone misses a real case: a `.docx` that
 * is really a renamed `.doc`, and a `.doc` the agent never downloads.
 */
export function assertDocxName(nameOrPath: string): void {
  if (!/\.docx$/i.test(nameOrPath.trim())) {
    throw new Error(
      `Word tools work on .docx files. "${nameOrPath}" is not one — legacy .doc files must be converted first.`,
    );
  }
}

export function formatItem(item: any): Record<string, unknown> {
  return {
    id: item?.id ?? null,
    name: item?.name ?? null,
    size: item?.size ?? null,
    createdDateTime: item?.createdDateTime ?? null,
    lastModifiedDateTime: item?.lastModifiedDateTime ?? null,
    webUrl: item?.webUrl ?? null,
  };
}
