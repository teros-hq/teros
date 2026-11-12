/**
 * Contract — the tunnel envelope and payload schemas accept exactly what the
 * teros-remote daemon emits (packages/protocol in that repo) and reject
 * malformed frames before they reach the gateway's dispatch.
 */
import { describe, expect, it } from 'bun:test';
import {
  createRemoteEnvelope,
  isRemoteEnvelope,
  isRetryableRemoteError,
  parseRemoteEnvelope,
  REMOTE_PROTOCOL_VERSION,
  RemoteErrorCode,
  RemoteHelloPayloadSchema,
  RemoteToolResultPayloadSchema,
} from './remote-protocol';

/** A hello exactly as the daemon's TunnelClient.onOpen builds it. */
const daemonHello = {
  deviceId: 'dev_0123456789abcdef',
  key: 'trsk_abc',
  hostname: 'raw',
  os: 'linux',
  arch: 'x64',
  daemonVersion: '0.1.0',
  allowedRoots: ['/home/alice'],
  execEnabled: false,
  capabilities: ['read-file', 'device-status'],
  maxInFlight: 4,
  protocolVersion: '1.0',
};

describe('remote-protocol envelope', () => {
  it('createRemoteEnvelope fills id/timestamp/version and keeps a given id for replies', () => {
    const call = createRemoteEnvelope('tool_call', { tool: 'read-file', arguments: {} });
    expect(call.version).toBe(REMOTE_PROTOCOL_VERSION);
    expect(call.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(call.timestamp))).toBe(false);

    const reply = createRemoteEnvelope('tool_result', { success: true, duration: 1 }, call.id);
    expect(reply.id).toBe(call.id);
  });

  it('isRemoteEnvelope matches the daemon guard (id + type + payload present)', () => {
    expect(isRemoteEnvelope({ id: 'x', type: 'ping', payload: {} })).toBe(true);
    expect(isRemoteEnvelope({ id: 'x', type: 'ping' })).toBe(false);
    expect(isRemoteEnvelope(null)).toBe(false);
    expect(isRemoteEnvelope('{}')).toBe(false);
  });

  it('parseRemoteEnvelope rejects non-JSON, unknown types and wrong versions', () => {
    expect(parseRemoteEnvelope('not json')).toBeNull();
    expect(
      parseRemoteEnvelope(JSON.stringify({ ...createRemoteEnvelope('ping', {}), type: 'nope' })),
    ).toBeNull();
    expect(
      parseRemoteEnvelope(JSON.stringify({ ...createRemoteEnvelope('ping', {}), version: '2.0' })),
    ).toBeNull();
    const ok = parseRemoteEnvelope(JSON.stringify(createRemoteEnvelope('hello', daemonHello)));
    expect(ok?.type).toBe('hello');
  });
});

describe('remote-protocol payloads', () => {
  it('accepts the daemon hello verbatim and rejects a hello without a key', () => {
    expect(RemoteHelloPayloadSchema.safeParse(daemonHello).success).toBe(true);
    const { key: _key, ...noKey } = daemonHello;
    expect(RemoteHelloPayloadSchema.safeParse(noKey).success).toBe(false);
  });

  it('hello.name is optional: parses with and without it', () => {
    const withName = RemoteHelloPayloadSchema.safeParse({ ...daemonHello, name: "Alice's Laptop" });
    expect(withName.success).toBe(true);
    if (withName.success) expect(withName.data.name).toBe("Alice's Laptop");

    const withoutName = RemoteHelloPayloadSchema.safeParse(daemonHello);
    expect(withoutName.success).toBe(true);
    if (withoutName.success) expect(withoutName.data.name).toBeUndefined();
  });

  it('accepts daemon tool_result shapes (success, structured error, partial-output TIMEOUT)', () => {
    expect(
      RemoteToolResultPayloadSchema.safeParse({ success: true, result: { ok: 1 }, duration: 3 })
        .success,
    ).toBe(true);
    expect(
      RemoteToolResultPayloadSchema.safeParse({
        success: false,
        duration: 0,
        error: { code: 'FORBIDDEN', message: 'outside roots', hint: 'Allowed roots: /home/alice' },
      }).success,
    ).toBe(true);
    expect(
      RemoteToolResultPayloadSchema.safeParse({
        success: false,
        duration: 120_000,
        result: { stdout: 'partial', stderr: '', exitCode: null },
        error: { code: 'TIMEOUT', message: 'killed', details: { stdout: 'partial' } },
      }).success,
    ).toBe(true);
    expect(
      RemoteToolResultPayloadSchema.safeParse({
        success: false,
        duration: 0,
        error: { code: 'WAT', message: 'x' },
      }).success,
    ).toBe(false);
  });

  it('error code set matches the daemon list exactly', () => {
    expect(Object.keys(RemoteErrorCode).sort()).toEqual(
      [
        'MACHINE_UNREACHABLE',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'TIMEOUT',
        'TOOL_NOT_FOUND',
        'INVALID_ARGUMENTS',
        'EXEC_DISABLED',
        'CANCELLED',
        'BUSY',
        'INTERNAL_ERROR',
      ].sort(),
    );
    expect(isRetryableRemoteError('MACHINE_UNREACHABLE')).toBe(true);
    expect(isRetryableRemoteError('FORBIDDEN')).toBe(false);
  });
});
