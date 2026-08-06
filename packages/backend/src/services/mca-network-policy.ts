/**
 * Docker network policy for MCA containers — egress isolation (TER-564, M3).
 *
 * MCA containers fall into three buckets, on DISJOINT networks so a compromised
 * egress MCA cannot reach internal services at the network layer (a control the
 * app-level SSRF guard cannot give, since pinning the validated IP needs a custom
 * transport incompatible with the global `fetch` the MCAs mock — see
 * mca-sdk/url-validation.ts):
 *
 *   1. INTERNAL  — platform MCAs that legitimately talk to Mongo/Qdrant. They join
 *      `teros_teros-network`, where those services live.
 *   2. EGRESS    — MCAs that call arbitrary public APIs (mca.teros.http) or a SaaS
 *      (mca.netlify, mca.make). They join the DEDICATED `teros_egress` network,
 *      which contains NO internal services. In production, host iptables on that
 *      subnet additionally drop the cloud-metadata endpoint (169.254.0.0/16) and
 *      RFC1918 ranges (allowing only the backend-callback gateway) — closing the
 *      DNS-rebinding TOCTOU at the network layer. See scripts/setup-egress-firewall.sh.
 *   3. NONE      — everything else gets no network (default-deny).
 */

/** Platform MCAs that legitimately reach internal services (Mongo/Qdrant). */
export const MCAS_WITH_INTERNAL_ACCESS: readonly string[] = [
  'mca.teros.scheduler',
  'mca.teros.memory',
  'mca.teros.docker-env',
  'mca.teros.feedback',
  'mca.teros.feedback-admin',
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

/** Fixed subnet for `teros_egress` so the host firewall (iptables) can target it.
 *  172.31.255.0/24 sits at the top of RFC1918 172.16/12, away from Docker's default
 *  bridge allocation (172.17+), minimising the chance of a clash. */
export const TEROS_EGRESS_SUBNET = '172.31.255.0/24';

/**
 * The Docker network an MCA container must join, or `undefined` for no network
 * (default-deny). INTERNAL and EGRESS are intentionally disjoint — see module doc.
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
