/** Largest file the app will hold in memory (suite spec §8.4). */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * The full field projection `formatItem` reads.
 *
 * `$select` is a genuine projection: a field left out here is simply absent
 * from the response, so a guard that tests it silently never fires. Keeping
 * the list next to `formatItem` is what stops the two from drifting.
 */
export const ITEM_SELECT =
  'id,name,folder,file,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference';

/**
 * Normalizes a user-supplied OneDrive path to Graph's expected form:
 * a leading slash, no trailing slash.
 */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Percent-encodes each segment of a normalized OneDrive path, preserving the
 * `/` separators. `#`, `?`, and `%` are all legal filename characters on
 * macOS/Linux but have special meaning in a URL, so a raw folder or file
 * name can silently truncate the path or be misdecoded by Graph.
 *
 * Callers pass **literal** names: this function does the encoding, so a
 * pre-encoded path would be double-encoded ("%20" -> "%2520").
 */
export function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment === '' ? segment : encodeURIComponent(segment)))
    .join('/');
}

/**
 * Resolves `itemId` or `path` arguments into a Graph item base path.
 * Falls back to the drive root when neither is supplied.
 *
 *   { itemId: 'abc' }            -> /me/drive/items/abc
 *   { path: 'Documents/a.txt' }  -> /me/drive/root:/Documents/a.txt:
 *   {}                           -> /me/drive/root
 *
 * The path is percent-encoded segment by segment. Without that, a name
 * containing `#` truncates the URL at the fragment marker and the request
 * silently targets a *different* item — on `delete-item` that means deleting
 * the wrong thing and reporting success.
 */
export function itemRef(a: Record<string, unknown>): string {
  const itemId = a.itemId as string | undefined;
  const path = a.path as string | undefined;

  if (itemId) return `/me/drive/items/${encodeURIComponent(itemId)}`;

  if (path) {
    const normalized = normalizePath(path);
    if (normalized === '') return '/me/drive/root';
    return `/me/drive/root:${encodePathSegments(normalized)}:`;
  }

  return '/me/drive/root';
}

/**
 * `itemRef` for tools where the drive root is never a sensible target.
 *
 * `itemRef({})` resolves to `/me/drive/root`, so a mistyped argument name on
 * `delete-item` would target the whole drive. JSON Schema `required` is
 * advisory in this stack — nothing validates arguments at runtime — so the
 * check has to live here.
 */
export function requireItemRef(a: Record<string, unknown>): string {
  if (!a.itemId && !a.path) {
    throw new Error('Specify itemId or path.');
  }
  return itemRef(a);
}

/**
 * Resolves the parent-folder arguments of `create-folder`.
 *
 * `parentId` / `parentPath` are the documented names; `itemId` / `path` are
 * kept as accepted aliases for backwards compatibility. The drive root is a
 * legitimate default here.
 */
export function parentRef(a: Record<string, unknown>): string {
  return itemRef({
    itemId: a.parentId ?? a.itemId,
    path: a.parentPath ?? a.path,
  });
}

/**
 * Builds the `parentReference` a move or copy sends, from
 * `destinationFolderId` (preferred) or `destinationPath`.
 *
 * Graph itself emits percent-encoded values in `parentReference.path`, so
 * encoding inbound is the consistent direction.
 */
export function destinationRef(a: Record<string, unknown>): { id: string } | { path: string } {
  const destinationFolderId = a.destinationFolderId as string | undefined;
  if (destinationFolderId) return { id: destinationFolderId };

  const destinationPath = normalizePath((a.destinationPath as string) || '');
  return { path: `/drive/root:${encodePathSegments(destinationPath)}` };
}

/** Throws when a payload exceeds the in-memory ceiling. */
export function assertSize(bytes: number, what: string): void {
  if (bytes > MAX_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    throw new Error(`${what} is ${mb} MB, above the 50 MB limit this app can handle in memory.`);
  }
}

/** The canonical shape every tool returns for a drive item. */
export function formatItem(item: any): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    type: item.folder ? 'folder' : 'file',
    size: item.size,
    mimeType: item.file?.mimeType,
    childCount: item.folder?.childCount,
    createdDateTime: item.createdDateTime,
    lastModifiedDateTime: item.lastModifiedDateTime,
    webUrl: item.webUrl,
    parentId: item.parentReference?.id,
    parentPath: item.parentReference?.path,
  };
}
