/**
 * Helpers for building Google Drive API v3 search queries safely.
 *
 * Drive's query language (the `q` parameter) embeds literal values inside single
 * quotes: `name contains 'foo'`. A value that itself contains a single quote — or a
 * backslash — breaks the query and the API rejects it with `Invalid Value`. The
 * tools used to interpolate user/agent-provided values raw, so any term with an
 * apostrophe (e.g. a filename like `O'Brien.pdf`, or an agent passing a raw clause
 * such as `not 'me' in owners` into the name filter) produced a hard failure.
 *
 * Per Google's spec, a single quote inside a quoted value is escaped as `\'` and a
 * backslash as `\\`. Order matters: escape backslashes first, then quotes.
 *
 * Incident: TER-514 smoke — `list-files` with `query: "not 'me' in owners"` →
 * `name contains 'not 'me' in owners'` → `Error: Invalid Value`.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Builds the `q` string for `list-files`, escaping every literal value. The optional
 * `driveQuery` is a raw Drive-syntax clause supplied by the caller and is appended
 * verbatim (parenthesised), so it is NOT escaped — escaping it would corrupt valid
 * operators like `not 'me' in owners`.
 */
export function buildListQuery(opts: {
  folderId?: string;
  query?: string;
  mimeType?: string;
  driveQuery?: string;
}): string {
  let q = 'trashed=false';
  if (opts.folderId) {
    q += ` and '${escapeQueryValue(opts.folderId)}' in parents`;
  }
  if (opts.query) {
    q += ` and name contains '${escapeQueryValue(opts.query)}'`;
  }
  if (opts.mimeType) {
    q += ` and mimeType='${escapeQueryValue(opts.mimeType)}'`;
  }
  if (opts.driveQuery) {
    q += ` and (${opts.driveQuery})`;
  }
  return q;
}
