import { describe, it, expect, beforeEach } from 'bun:test';
import { ChannelWorkerRegistry } from '@teros/core';
import {
  getChannelWorkerRegistry,
  __resetChannelWorkerRegistryForTests,
} from '../../src/services/channel-worker-host';

describe('channel-worker-host', () => {
  beforeEach(() => {
    __resetChannelWorkerRegistryForTests();
  });

  it('getChannelWorkerRegistry returns the same singleton across calls', () => {
    const r1 = getChannelWorkerRegistry();
    const r2 = getChannelWorkerRegistry();

    expect(r1).toBeInstanceOf(ChannelWorkerRegistry);
    expect(r1).toBe(r2);
  });

  it('getChannelWorkerRegistry without prior set lazily creates a ChannelWorkerRegistry (no throw)', () => {
    const r = getChannelWorkerRegistry();
    expect(r).toBeInstanceOf(ChannelWorkerRegistry);
  });

  it('__resetChannelWorkerRegistryForTests resets the singleton — next get returns a new instance', () => {
    const r1 = getChannelWorkerRegistry();
    __resetChannelWorkerRegistryForTests();
    const r2 = getChannelWorkerRegistry();

    expect(r1).not.toBe(r2);
    expect(r2).toBeInstanceOf(ChannelWorkerRegistry);
  });
});
