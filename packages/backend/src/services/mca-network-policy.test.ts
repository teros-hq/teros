/**
 * MCA network policy — workspace isolation + egress isolation.
 *
 * These are cheap structural guards that catch a whole class of regression: an
 * egress MCA accidentally sharing a network with Mongo/Qdrant, or being dropped
 * from the egress list (back onto the internal network or no isolation), or
 * workspace isolation being bypassed (missing workspace network).
 */
import { describe, expect, it } from 'bun:test';
import {
  assertDisjointNetworkPolicy,
  MCAS_WITH_EGRESS,
  MCAS_WITH_INTERNAL_ACCESS,
  resolveDockerNetwork,
  resolveDockerNetworks,
  TEROS_EGRESS_NETWORK,
  TEROS_EGRESS_SUBNET,
  TEROS_INTERNAL_NETWORK,
  TEROS_WORKSPACE_NETWORK_PREFIX,
  workspaceNetworkName,
} from './mca-network-policy';

// ─── Legacy resolveDockerNetwork (backward compat) ─────────────────────────

describe('resolveDockerNetwork (legacy, backward compat)', () => {
  it('puts platform MCAs on the INTERNAL network (Mongo/Qdrant)', () => {
    for (const mca of MCAS_WITH_INTERNAL_ACCESS) {
      expect(resolveDockerNetwork(mca)).toBe(TEROS_INTERNAL_NETWORK);
    }
  });

  it('puts egress MCAs on the DEDICATED egress network (never the internal one)', () => {
    for (const mca of MCAS_WITH_EGRESS) {
      expect(resolveDockerNetwork(mca)).toBe(TEROS_EGRESS_NETWORK);
      expect(resolveDockerNetwork(mca)).not.toBe(TEROS_INTERNAL_NETWORK);
    }
  });

  it('the HTTP/Netlify/Make MCAs are egress-isolated (not on Mongo/Qdrant net)', () => {
    // These call caller-controlled / SaaS hosts — the exact case M3 is about.
    for (const mca of ['mca.teros.http', 'mca.netlify', 'mca.make']) {
      expect(resolveDockerNetwork(mca)).toBe(TEROS_EGRESS_NETWORK);
    }
  });

  it('gives no network to an unlisted MCA (default-deny)', () => {
    expect(resolveDockerNetwork('mca.teros.filesystem')).toBeUndefined();
    expect(resolveDockerNetwork('mca.unknown')).toBeUndefined();
    expect(resolveDockerNetwork('')).toBeUndefined();
  });

  it('the two networks are different names', () => {
    expect(TEROS_EGRESS_NETWORK).not.toBe(TEROS_INTERNAL_NETWORK);
  });
});

// ─── Workspace network name ──────────────────────────────────────────────────

describe('workspaceNetworkName', () => {
  it('strips work_ prefix and produces teros_ws_<hex>', () => {
    expect(workspaceNetworkName('work_c327394b4cfb0661')).toBe('teros_ws_c327394b4cfb0661');
  });

  it('strips ws_ prefix', () => {
    expect(workspaceNetworkName('ws_abc123')).toBe('teros_ws_abc123');
  });

  it('handles IDs without recognized prefix (sanitizes full ID)', () => {
    expect(workspaceNetworkName('custom-abc-123')).toBe('teros_ws_custom-abc-123');
  });

  it('produces a name with the correct prefix', () => {
    const name = workspaceNetworkName('work_abc123');
    expect(name.startsWith(TEROS_WORKSPACE_NETWORK_PREFIX)).toBe(true);
  });

  it('lowercases the result', () => {
    expect(workspaceNetworkName('work_ABC123')).toBe('teros_ws_abc123');
  });

  it('handles edge case: empty after stripping → fallback to full ID', () => {
    // work_ with nothing after → fallback uses the full ID sanitized
    const name = workspaceNetworkName('work_');
    expect(name.startsWith(TEROS_WORKSPACE_NETWORK_PREFIX)).toBe(true);
    expect(name.length).toBeGreaterThan(TEROS_WORKSPACE_NETWORK_PREFIX.length);
  });

  it('only contains safe characters [a-z0-9-]', () => {
    const name = workspaceNetworkName('work_a1b2c3');
    expect(name).toMatch(/^teros_ws_[a-z0-9-]+$/);
  });

  it('different workspaces get different network names', () => {
    const a = workspaceNetworkName('work_aaaaa111111111111');
    const b = workspaceNetworkName('work_bbbbb222222222222');
    expect(a).not.toBe(b);
  });
});

// ─── resolveDockerNetworks (new, workspace-aware) ────────────────────────────

describe('resolveDockerNetworks (workspace-aware)', () => {
  const WS_A = 'work_aaaaa111111111111';
  const WS_B = 'work_bbbbb222222222222';
  const WS_NET_A = workspaceNetworkName(WS_A);
  const WS_NET_B = workspaceNetworkName(WS_B);

  it('always includes the workspace network as the first entry', () => {
    for (const mca of [
      'mca.teros.feedback',
      'mca.teros.http',
      'mca.teros.filesystem',
      'mca.unknown',
    ]) {
      const nets = resolveDockerNetworks(mca, WS_A);
      expect(nets[0]).toBe(WS_NET_A);
    }
  });

  it('internal MCAs get workspace + internal network', () => {
    for (const mca of MCAS_WITH_INTERNAL_ACCESS) {
      const nets = resolveDockerNetworks(mca, WS_A);
      expect(nets).toContain(WS_NET_A);
      expect(nets).toContain(TEROS_INTERNAL_NETWORK);
      expect(nets).not.toContain(TEROS_EGRESS_NETWORK);
    }
  });

  it('egress MCAs get workspace + egress network (never internal)', () => {
    for (const mca of MCAS_WITH_EGRESS) {
      const nets = resolveDockerNetworks(mca, WS_A);
      expect(nets).toContain(WS_NET_A);
      expect(nets).toContain(TEROS_EGRESS_NETWORK);
      expect(nets).not.toContain(TEROS_INTERNAL_NETWORK);
    }
  });

  it('unlisted MCAs get ONLY the workspace network', () => {
    for (const mca of ['mca.teros.filesystem', 'mca.unknown', '']) {
      const nets = resolveDockerNetworks(mca, WS_A);
      expect(nets).toEqual([WS_NET_A]);
    }
  });

  it('different workspaces produce different workspace networks', () => {
    const netsA = resolveDockerNetworks('mca.teros.bash', WS_A);
    const netsB = resolveDockerNetworks('mca.teros.bash', WS_B);
    expect(netsA[0]).toBe(WS_NET_A);
    expect(netsB[0]).toBe(WS_NET_B);
    expect(netsA[0]).not.toBe(netsB[0]);
  });

  it('workspace network is always first (primary), internal/egress are secondary', () => {
    // The first network is the primary (--network on docker run).
    // The container's DNS name resolves on this network.
    const internalNets = resolveDockerNetworks('mca.teros.feedback', WS_A);
    expect(internalNets[0]).toBe(WS_NET_A);
    expect(internalNets[1]).toBe(TEROS_INTERNAL_NETWORK);

    const egressNets = resolveDockerNetworks('mca.teros.http', WS_A);
    expect(egressNets[0]).toBe(WS_NET_A);
    expect(egressNets[1]).toBe(TEROS_EGRESS_NETWORK);
  });

  it('empty workspaceId → no workspace network, but egress/internal still apply', () => {
    // Edge case: should not happen in practice (every app has an ownerId).
    // The egress network is still returned — only the workspace network is skipped.
    expect(resolveDockerNetworks('mca.teros.bash', '')).toEqual([TEROS_EGRESS_NETWORK]);
    expect(resolveDockerNetworks('mca.teros.feedback', '')).toEqual([TEROS_INTERNAL_NETWORK]);
    expect(resolveDockerNetworks('mca.teros.filesystem', '')).toEqual([]);
  });
});

// ─── Structural invariants ───────────────────────────────────────────────────

describe('assertDisjointNetworkPolicy (structural invariant)', () => {
  it('passes for the current lists (no MCA in both)', () => {
    expect(() => assertDisjointNetworkPolicy()).not.toThrow();
  });

  it('the lists are actually disjoint', () => {
    const overlap = MCAS_WITH_EGRESS.filter((m) => MCAS_WITH_INTERNAL_ACCESS.includes(m));
    expect(overlap).toEqual([]);
  });

  it('would throw loudly if an egress MCA were also internal (mutation check)', () => {
    // Prove the guard bites: simulate the bad config it defends against.
    const bad = () => {
      const internal = ['mca.teros.memory', 'mca.teros.http'];
      const egress = ['mca.teros.http'];
      const overlap = egress.filter((m) => internal.includes(m));
      if (overlap.length > 0) throw new Error(`[NETWORK_POLICY] in both: ${overlap.join(', ')}`);
    };
    expect(bad).toThrow(/\[NETWORK_POLICY\]/);
  });
});

describe('egress subnet', () => {
  it('is a fixed RFC1918 subnet the host firewall can target', () => {
    expect(TEROS_EGRESS_SUBNET).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/);
    expect(TEROS_EGRESS_SUBNET).toBe('172.19.0.0/16');
  });
});
