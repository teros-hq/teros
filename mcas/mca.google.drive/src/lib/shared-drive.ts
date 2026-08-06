/**
 * Shared Drive (formerly Team Drive) support for the Google Drive API v3.
 *
 * The Drive API treats shared drives as opt-in: every files.{get,list,create,
 * update,copy,delete} and permissions.* request MUST carry `supportsAllDrives=true`,
 * or the API returns `404 File not found` for any item that lives in a shared drive —
 * even when the user has full access to it. `files.list` additionally needs
 * `includeItemsFromAllDrives=true` and `corpora='allDrives'` to return items from
 * both My Drive and the shared drives the user belongs to.
 *
 * `supportsAllDrives` is still REQUIRED as of 2026 — verified against Google's
 * "Implement shared drive support" guide
 * (https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).
 * The June-2020 "assumed true" deprecation note that circulates online refers to the
 * older `supportsTeamDrives` flag, NOT this one.
 *
 * Methods that operate by `fileId` alone — `files.export`, `comments.*`, `replies.*` —
 * do NOT accept these parameters and already work on shared-drive files, so they are
 * intentionally left untouched.
 *
 * Guarded structurally by `test/shared-drive.test.ts`: every gated call-site is
 * required to spread one of these constants, so a future tool cannot silently
 * reintroduce the bug.
 */

/**
 * Spread into every `files.{get,create,update,copy,delete}` and `permissions.*` call.
 */
export const ALL_DRIVES = { supportsAllDrives: true } as const;

/**
 * Spread into `files.list` to include My Drive + all shared drives the user can access.
 *
 * `corpora: 'allDrives'` is the broadest scope (My Drive + every shared drive). Google
 * recommends narrower scopes (`user`/`drive`) for high-volume apps, but for an agent
 * tool that should "see everything the user can" it is the correct default. When the
 * scope is too broad to search exhaustively the API sets `incompleteSearch=true` on the
 * response, which the list/search tools surface so the agent can narrow its query.
 */
export const ALL_DRIVES_LIST = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives',
} as const;
