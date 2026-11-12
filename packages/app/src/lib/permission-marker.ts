/**
 * The v4 `permission_requested` marker — shared by the chat hooks (grouping,
 * rehydration) and the per-card permission surface (`withPermissionSupport`).
 *
 * Lives outside `components/` so the pure hooks can read it without importing
 * a component module.
 */

/**
 * Parse the v4 awaiting-user permission marker from a COMPLETED tool's output.
 *
 * v4 permission cut (2026-10-27): the ask ends the turn with a
 * `{ status: 'permission_requested', permissionRequestId, appId, irreversible }`
 * JSON marker as the tool result. Rows written before PERMB 1.0.0 settled the
 * message as `completed` and DROPPED `permissionRequestId`/`appId`/`irreversible`
 * from the content, so for those rows that JSON is the ONLY durable anchor for
 * the decision surface (PERMB-REQ-2 keeps parsing it as a fallback).
 * Null on absent/corrupt output or a non-marker payload.
 *
 * @spec PERMB-REQ-4
 */
export function parsePermissionMarker(
  output?: string,
): { permissionRequestId: string; appId?: string; irreversible?: boolean } | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as Record<string, unknown> | null
    if (
      parsed &&
      parsed.status === "permission_requested" &&
      typeof parsed.permissionRequestId === "string" &&
      parsed.permissionRequestId !== ""
    ) {
      return {
        permissionRequestId: parsed.permissionRequestId,
        appId: typeof parsed.appId === "string" && parsed.appId !== "" ? parsed.appId : undefined,
        irreversible: parsed.irreversible === true,
      }
    }
    return null
  } catch {
    return null
  }
}
