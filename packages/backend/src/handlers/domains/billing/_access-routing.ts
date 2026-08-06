/**
 * Who receives the in-app notification when a user requests billing access
 * (TER-596 T1).
 *
 * CHANGE OF MEANING — read before touching: this used to ALWAYS fan out to every
 * admin/super. Now, when the requester belongs to a billing_team whose owner is
 * a resolvable ADMIN, the push goes ONLY to that owner (the team's "company
 * admin"); Teros admins stop receiving every team's request noise (they still
 * see the global admin.list-access-requests queue). Otherwise — no team, no
 * owner, a stale owner id, or an owner who is no longer an admin/super — it falls
 * back to every admin/super, the legacy behavior.
 *
 * Why the owner MUST be an admin: the Billing Requests window and badge are gated
 * `isAdmin`, so routing to a non-admin owner would strand the request where
 * nobody can act on it. Until a dedicated "company admin" role + UI exist, an
 * owner who isn't admin/super falls back to the global admin audience.
 *
 * The requester is always removed from the audience — nobody is notified of
 * their own request (an admin/owner requesting access for themselves).
 *
 * Kept as a single pure function so the routing has ONE authority and is pinned
 * by tests that break if a team request ever notifies everyone again, if a
 * non-admin owner is routed to, or if the requester self-notifies.
 */
export function resolveAccessRequestRecipients(params: {
  /** The user making the request — never notified about their own request. */
  requesterId: string
  /** ownerId of the requester's team, or null when they are not in a team. */
  teamOwnerId: string | null
  /** Whether teamOwnerId resolves to a real admin/super user (else fall back). */
  ownerIsResolvable: boolean
  /** Every admin/super userId — the fallback audience. */
  adminUserIds: string[]
}): string[] {
  const { requesterId, teamOwnerId, ownerIsResolvable, adminUserIds } = params
  const audience = teamOwnerId && ownerIsResolvable ? [teamOwnerId] : adminUserIds
  return audience.filter((id) => id !== requesterId)
}
