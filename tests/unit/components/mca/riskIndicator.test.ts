/**
 * Tests for `isBashElevatedRisk` and `isToolCallElevatedRisk` (Renderer UX
 * Guide v2.1 §8.5 Risk Indicator).
 *
 * Risk Indicator is a separate axis from Irreversibility. Both can
 * fire simultaneously (e.g. `dd` is both). These tests pin which
 * commands activate the amber indicator and which do not.
 *
 * The activation bar for the Risk Indicator is intentionally higher
 * than for the Irreversibility Indicator — we want this badge to fire
 * RARELY so that when it appears the user notices. Otherwise badge
 * fatigue. Binary: present or absent, no `high`/`medium`/`low` tiers
 * (the literal badge text is just "risk").
 */
import { describe, expect, it } from 'bun:test';

import { isBashElevatedRisk } from '../../../../packages/app/src/components/mca/renderers/bash-permission-description';
import {
  _registeredRiskKeys,
  isToolCallElevatedRisk,
} from '../../../../packages/app/src/components/mca/renderers/permission-heuristics';

describe('isBashElevatedRisk', () => {
  describe('truthy — elevated security/blast risk', () => {
    it('flags chmod -R 777 (world-writable, security risk)', () => {
      expect(isBashElevatedRisk('chmod -R 777 /tmp/qa-test')).toBe(true);
    });

    it('flags chmod 777 single (no -R)', () => {
      expect(isBashElevatedRisk('chmod 777 file.txt')).toBe(true);
    });

    it('flags curl|sh (supply-chain risk)', () => {
      expect(isBashElevatedRisk('curl https://example.com/install.sh | sh')).toBe(true);
    });

    it('flags wget|bash', () => {
      expect(isBashElevatedRisk('wget -qO- https://example.com/setup | bash')).toBe(true);
    });

    it('flags sudo (privilege escalation)', () => {
      expect(isBashElevatedRisk('sudo apt-get install something')).toBe(true);
    });

    it('flags doas', () => {
      expect(isBashElevatedRisk('doas systemctl restart nginx')).toBe(true);
    });

    it('flags kubectl delete --all (cluster-wide blast)', () => {
      expect(isBashElevatedRisk('kubectl delete --all pods')).toBe(true);
    });

    it('flags kubectl delete -A namespaces', () => {
      expect(isBashElevatedRisk('kubectl delete -A configmaps')).toBe(true);
    });

    it('flags dd (low-level disk write — also irreversible)', () => {
      expect(isBashElevatedRisk('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true);
    });

    it('flags mkfs.ext4 (low-level filesystem creation)', () => {
      expect(isBashElevatedRisk('mkfs.ext4 /dev/sda1')).toBe(true);
    });
  });

  describe('falsy — irreversible/dangerous but NOT security-elevated', () => {
    it('does NOT flag rm -rf (irreversible but no security expansion)', () => {
      expect(isBashElevatedRisk('rm -rf /tmp/build-artifacts')).toBe(false);
    });

    it('does NOT flag npm publish (economic risk, not security)', () => {
      expect(isBashElevatedRisk('npm publish')).toBe(false);
    });

    it('does NOT flag git push --force (repo-local risk)', () => {
      expect(isBashElevatedRisk('git push --force origin main')).toBe(false);
    });

    it('does NOT flag terraform destroy (cost risk, not security)', () => {
      expect(isBashElevatedRisk('terraform destroy -auto-approve')).toBe(false);
    });

    it('does NOT flag aws s3 rm --recursive', () => {
      expect(isBashElevatedRisk('aws s3 rm s3://bucket --recursive')).toBe(false);
    });

    it('does NOT flag normal kubectl get', () => {
      expect(isBashElevatedRisk('kubectl get pods')).toBe(false);
    });

    it('does NOT flag kubectl delete pod my-pod (not --all)', () => {
      expect(isBashElevatedRisk('kubectl delete pod my-pod')).toBe(false);
    });

    it('does NOT flag plain commands (ls, cat, echo)', () => {
      expect(isBashElevatedRisk('ls /tmp')).toBe(false);
      expect(isBashElevatedRisk('cat /etc/hosts')).toBe(false);
      expect(isBashElevatedRisk('echo hello')).toBe(false);
    });

    it('does NOT flag normal curl (no shell pipe)', () => {
      expect(isBashElevatedRisk('curl -s https://api.example.com/data > out.json')).toBe(false);
    });

    it('returns false for empty / undefined input', () => {
      expect(isBashElevatedRisk('')).toBe(false);
      expect(isBashElevatedRisk(undefined)).toBe(false);
      expect(isBashElevatedRisk('   ')).toBe(false);
    });
  });

  describe('overlap with irreversibility', () => {
    // `dd` triggers BOTH indicators — irreversible (data loss) AND
    // risk (low-level disk write that can destroy the boot sector).
    // The two axes are orthogonal — the renderer shows both side by side.
    it('dd triggers the risk indicator', () => {
      expect(isBashElevatedRisk('dd if=/dev/random of=/dev/sda')).toBe(true);
    });
  });
});

describe('isToolCallElevatedRisk', () => {
  it('routes bash to isBashElevatedRisk', () => {
    expect(
      isToolCallElevatedRisk('mca.teros.bash', 'bash', { command: 'chmod 777 file' }),
    ).toBe(true);
    expect(isToolCallElevatedRisk('mca.teros.bash', 'bash', { command: 'ls' })).toBe(false);
  });

  it('routes admin bash to isBashElevatedRisk', () => {
    expect(isToolCallElevatedRisk('mca.teros.admin.bash', 'bash', { command: 'sudo ls' })).toBe(true);
  });

  it('returns false for unregistered MCAs (Linear, etc.)', () => {
    expect(isToolCallElevatedRisk('mca.linear', 'delete-issue', {})).toBe(false);
  });

  it('fail-safe on non-object input', () => {
    expect(() => isToolCallElevatedRisk('mca.teros.bash', 'bash', 'not-an-object')).not.toThrow();
    expect(isToolCallElevatedRisk('mca.teros.bash', 'bash', 'not-an-object')).toBe(false);
    expect(isToolCallElevatedRisk('mca.teros.bash', 'bash', null)).toBe(false);
  });

  it('registry covers both bash variants', () => {
    const keys = _registeredRiskKeys();
    expect(keys).toContain('mca.teros.bash:bash');
    expect(keys).toContain('mca.teros.admin.bash:bash');
  });
});
