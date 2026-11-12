/**
 * Docker network policy for MCA containers — workspace isolation + egress isolation.
 *
 * Defence-in-depth network isolation (incident-2026-08-14, Capa A):
 *
 *   1. WORKSPACE  — every MCA container joins a per-workspace bridge network
 *      `teros_ws_<workspaceId>`. Containers from different workspaces are on
 *      disjoint networks and cannot reach each other at the L2/L3 layer.
 *   2. INTERNAL    — platform MCAs that legitimately talk to Mongo/Qdrant ALSO join
 *      `teros_teros-network`, where those services live (in addition to their
 *      workspace network). This preserves internal access while keeping
 *      workspace isolation.
 *   3. EGRESS      — MCAs that call arbitrary public APIs (mca.teros.http) or a SaaS
 *      (mca.netlify, mca.make). They join the DEDICATED `teros_egress` network,
 *      which contains NO internal services, IN ADDITION to their workspace network.
 *      In production, host iptables on that subnet additionally drop the
 *      cloud-metadata endpoint (169.254.0.0/16) and RFC1918 ranges (allowing only
 *      the backend-callback gateway) — closing the DNS-rebinding TOCTOU at the
 *      network layer. See scripts/setup-egress-firewall.sh.
 *   4. NONE        — MCAs that don't need any network beyond their workspace network
 *      get only that (default-deny for cross-workspace and internal access).
 *
 * The workspace network is always present (every MCA belongs to a workspace). The
 * INTERNAL/EGRESS layers are additive on top, and remain disjoint from each other.
 */

/** Platform MCAs that legitimately reach internal services (Mongo/Qdrant). */
export const MCAS_WITH_INTERNAL_ACCESS: readonly string[] = [
  'mca.teros.feedback',
];

/**
 * MCAs that reach arbitrary public APIs / SaaS — isolated on the egress network.
 * mca.teros.bash is here so its shell (apt-get, curl, ...) has internet while the
 * prod egress firewall still blocks cloud metadata + RFC1918. Left on the default
 * bridge it would reach internal hosts/ports, contradicting the default-deny above.
 */
export const MCAS_WITH_EGRESS: readonly string[] = [
  'mca.teros.http',
  'mca.netlify',
  'mca.make',
  'mca.teros.bash',
];

export const TEROS_INTERNAL_NETWORK = 'teros_teros-network';
export const TEROS_EGRESS_NETWORK = 'teros_egress';

/** Prefix for per-workspace networks: `teros_ws_<sanitized-workspaceId>`. */
export const TEROS_WORKSPACE_NETWORK_PREFIX = 'teros_ws_';

/** Preferred subnet for `teros_egress` so the host firewall (iptables) can target it.
 *  172.19.0.0/16 matches the subnet Docker actually assigned to `teros_egress` in
 *  production. The original preference was 172.31.255.0/24 (top of RFC1918 172.16/12,
 *  away from Docker's default bridge), but a pool overlap caused Docker to fall back
 *  to this auto-assigned subnet. The firewall script reads the LIVE subnet via
 *  `docker inspect`, so rules always match reality regardless of this constant. */
export const TEROS_EGRESS_SUBNET = '172.19.0.0/16';

/**
 * Sanitize a workspaceId into a valid Docker network name.
 * Docker network names allow [a-zA-Z0-9_.-] but we use only [a-zA-Z0-9-] to keep
 * it simple and avoid any shell metacharacter risk. The workspaceId typically
 * looks like `work_c327394b4cfb0661` — we strip the prefix and keep the hex part.
 * Falls back to a safe slug of the full ID if the prefix is unexpected.
 */
export function workspaceNetworkName(workspaceId: string): string {
  // Strip common workspace ID prefixes (work_, ws_) and keep the rest.
  // If no recognized prefix, use the full ID sanitized.
  const stripped = workspaceId.replace(/^(work_|ws_)/, '');
  const safe = stripped.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  // If stripping produced an empty string (edge case), hash the original.
  if (!safe) {
    const fallback = workspaceId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return `${TEROS_WORKSPACE_NETWORK_PREFIX}${fallback || 'unknown'}`;
  }
  return `${TEROS_WORKSPACE_NETWORK_PREFIX}${safe}`;
}

/**
 * The set of Docker networks an MCA container must join.
 *
 * Always includes the workspace network. Additionally includes:
 *   - TEROS_INTERNAL_NETWORK for platform MCAs that need Mongo/Qdrant
 *   - TEROS_EGRESS_NETWORK for MCAs that need outbound internet (isolated from internal)
 *
 * Returns an empty array only if workspaceId is empty (which should never happen
 * in the unified model — every app has an ownerId that is a workspaceId).
 *
 * @param mcaId       The MCA catalog ID (e.g. 'mca.teros.bash')
 * @param workspaceId The owner workspace ID (e.g. 'work_c327394b4cfb0661')
 */
export function resolveDockerNetworks(mcaId: string, workspaceId: string): string[] {
  const networks: string[] = [];

  // Every MCA belongs to a workspace → always join the workspace network.
  if (workspaceId) {
    networks.push(workspaceNetworkName(workspaceId));
  }

  // Internal MCAs also join the platform network (Mongo/Qdrant access).
  if (MCAS_WITH_INTERNAL_ACCESS.includes(mcaId)) {
    networks.push(TEROS_INTERNAL_NETWORK);
  }

  // Egress MCAs also join the isolated egress network (outbound internet,
  // no internal services reachable).
  if (MCAS_WITH_EGRESS.includes(mcaId)) {
    networks.push(TEROS_EGRESS_NETWORK);
  }

  return networks;
}

/**
 * Legacy single-network resolution — kept for backward compatibility.
 * Returns the FIRST non-workspace network (internal or egress), or undefined.
 * New code should use resolveDockerNetworks() which includes the workspace network.
 *
 * @deprecated Use resolveDockerNetworks(mcaId, workspaceId) instead.
 */
export function resolveDockerNetwork(mcaId: string): string | undefined {
  if (MCAS_WITH_INTERNAL_ACCESS.includes(mcaId)) return TEROS_INTERNAL_NETWORK;
  if (MCAS_WITH_EGRESS.includes(mcaId)) return TEROS_EGRESS_NETWORK;
  return undefined;
}

/**
 * Structural invariant (lint-as-test): no MCA may be in BOTH lists. If one were, it
 * would join the internal network and the egress isolation would be silently void
 * for it. Called from a test so a future edit that puts an MCA in both fails the
 * build instead of shipping a hole.
 */
export function assertDisjointNetworkPolicy(): void {
  const overlap = MCAS_WITH_EGRESS.filter((m) => MCAS_WITH_INTERNAL_ACCESS.includes(m));
  if (overlap.length > 0) {
    throw new Error(
      `[NETWORK_POLICY] MCA(s) in both INTERNAL and EGRESS lists — egress isolation is void for them: ${overlap.join(', ')}`,
    );
  }
}
