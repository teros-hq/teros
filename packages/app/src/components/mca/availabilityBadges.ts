/**
 * Availability badges — shared prop helper for the MCA catalog (TER-530).
 *
 * Turns an MCA `availability` descriptor into a small set of status chips,
 * consumed by both the catalog card (`CatalogWindow`) and the detail view
 * (`CatalogDetailWindow`). The helper is pure (no theme, no JSX) and returns
 * tint *keys* — the call site resolves the actual colour through
 * `useColors().badges[tint]`, so the chips follow the active theme for free.
 *
 * Design rationale (signal over noise):
 *  - `system`  → "System"   — the MCA is auto-provisioned, never installed.
 *  - `multi`   → "Multi-instance" — installable more than once.
 *  - role≠user → "Admin only" — install gated behind an admin/super role.
 *
 * `multi` is the common case (most third-party MCAs allow it), so the card
 * call site filters it out to avoid a chip on nearly every tile; the detail
 * view shows all three since it has the horizontal room and the context.
 */

export type AvailabilityBadgeTint = "gray" | "info" | "warn";

export interface AvailabilityBadge {
  key: "system" | "multi" | "admin";
  label: string;
  tint: AvailabilityBadgeTint;
}

export interface AvailabilityLike {
  multi?: boolean;
  system?: boolean;
  role?: string;
}

export function availabilityBadges(a: AvailabilityLike | undefined | null): AvailabilityBadge[] {
  if (!a) return [];
  const out: AvailabilityBadge[] = [];
  if (a.system) out.push({ key: "system", label: "System", tint: "gray" });
  if (a.multi) out.push({ key: "multi", label: "Multi-instance", tint: "info" });
  if (a.role && a.role !== "user") out.push({ key: "admin", label: "Admin only", tint: "warn" });
  return out;
}
