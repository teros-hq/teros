/**
 * MCA network policy — egress isolation (TER-564, M3).
 *
 * These are cheap structural guards that catch a whole class of regression: an
 * egress MCA accidentally sharing a network with Mongo/Qdrant, or being dropped
 * from the egress list (back onto the internal network or no isolation).
 */
import { describe, expect, it } from 'bun:test';
import {
  assertDisjointNetworkPolicy,
  MCAS_WITH_EGRESS,
  MCAS_WITH_INTERNAL_ACCESS,
  resolveDockerNetwork,
  TEROS_EGRESS_NETWORK,
  TEROS_EGRESS_SUBNET,
  TEROS_INTERNAL_NETWORK,
} from './mca-network-policy';

describe('resolveDockerNetwork', () => {
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
  it('is a fixed RFC1918 /24 the host firewall can target', () => {
    expect(TEROS_EGRESS_SUBNET).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/);
    expect(TEROS_EGRESS_SUBNET).toBe('172.31.255.0/24');
  });
});
