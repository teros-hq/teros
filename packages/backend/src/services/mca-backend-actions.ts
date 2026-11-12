/**
 * Allowlist of WsRouter actions an MCA may invoke through the WS bridge
 * (`domain_request` / `admin_request`). Declared in the manifest as
 * `backend.actions` and synced into mca_catalog.backendActions.
 *
 * Patterns: an exact action (`automate.get`) or a whole domain
 * (`automate.*`). Fail closed: no declaration → nothing allowed.
 */

export function isBackendActionAllowed(allowlist: readonly string[] | undefined, action: string): boolean {
  if (!allowlist || allowlist.length === 0) return false
  if (!action || !action.includes('.')) return false
  const domain = action.slice(0, action.indexOf('.'))
  for (const pattern of allowlist) {
    if (pattern === action) return true
    if (pattern.endsWith('.*') && pattern.slice(0, -2) === domain) return true
  }
  return false
}
