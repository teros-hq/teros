/**
 * Entity factories — builders for creating test instances with sensible defaults.
 *
 * Each factory accepts a partial override object so tests only specify
 * the fields they care about.
 *
 * @example
 *   const agent = makeAgent({ name: 'Custom' });
 *   const channel = makeChannel({ userId: 'user:alice' });
 */

import { AGENT_IRIA, TEST_CORE, TEST_MODEL } from '../fixtures/agents.js';

// ── Agent ─────────────────────────────────────────────────────────────────────

export interface AgentOverride {
  agentId?: string;
  coreId?: string;
  name?: string;
  fullName?: string;
  role?: string;
  intro?: string;
  status?: string;
}

export function makeAgent(overrides: AgentOverride = {}) {
  return {
    ...AGENT_IRIA,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Core ──────────────────────────────────────────────────────────────────────

export function makeCore(overrides: Partial<typeof TEST_CORE> = {}) {
  return {
    ...TEST_CORE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Model ─────────────────────────────────────────────────────────────────────

export function makeModel(overrides: Partial<typeof TEST_MODEL> = {}) {
  return {
    ...TEST_MODEL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Channel ───────────────────────────────────────────────────────────────────

let _channelSeq = 0;

export interface ChannelOverride {
  channelId?: string;
  userId?: string;
  agentId?: string;
  status?: string;
  name?: string;
}

export function makeChannel(overrides: ChannelOverride = {}) {
  _channelSeq++;
  return {
    channelId: `ch_test_${_channelSeq}`,
    userId: 'user:test',
    agentId: 'agent:iria',
    status: 'active',
    name: `Test Channel ${_channelSeq}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
