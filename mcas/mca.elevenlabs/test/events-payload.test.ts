/**
 * Drift guard: the event catalog (manifest.json → events[].payload) is what
 * agents and the Automate window use to write filters and templates. These
 * tests pin the emitted payload to that catalog so the two can never drift
 * apart — same pattern as mca.telegram/test/events-payload.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { buildCallStartedPayload, ELEVENLABS_EVENT_TOPICS } from '../src/events';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  events: Array<{ topic: string; description?: string; payload: Record<string, string> }>;
};
const declared = (topic: string) => Object.keys(manifest.events.find((e) => e.topic === topic)!.payload);

describe('elevenlabs.call.started payload matches the manifest catalog', () => {
  it('every declared field is present in the emitted payload', () => {
    const payload = buildCallStartedPayload({
      conversationId: 'conv_abc123',
      callSid: 'CAxyz789',
      toNumber: '+34600123456',
      agentId: 'agent_def456',
      phoneNumberId: 'phnum_ghi789',
      initiatorChannelId: 'ch_123',
      initiatorAgentId: 'agent_456',
    });

    for (const key of declared('elevenlabs.call.started')) {
      expect(payload).toHaveProperty(key);
    }

    expect(payload.conversationId).toBe('conv_abc123');
    expect(payload.callSid).toBe('CAxyz789');
    expect(payload.toNumber).toBe('+34600123456');
    expect(payload.agentId).toBe('agent_def456');
    expect(payload.phoneNumberId).toBe('phnum_ghi789');
    expect(payload.initiatorChannelId).toBe('ch_123');
    expect(payload.initiatorAgentId).toBe('agent_456');
    expect(typeof payload.occurredAt).toBe('string');
    // ISO date sanity
    expect(new Date(payload.occurredAt).toISOString()).toBe(payload.occurredAt);
  });

  it('nulls are preserved (no silent key drops when ElevenLabs omits fields)', () => {
    const payload = buildCallStartedPayload({
      conversationId: null,
      callSid: null,
      toNumber: '+34600123456',
      agentId: 'agent_def456',
      phoneNumberId: 'phnum_ghi789',
      initiatorChannelId: null,
      initiatorAgentId: null,
    });

    expect(payload.conversationId).toBeNull();
    expect(payload.callSid).toBeNull();
    expect(payload.initiatorChannelId).toBeNull();
    expect(payload.initiatorAgentId).toBeNull();
    // Keys still present — templates can rely on them existing
    for (const key of declared('elevenlabs.call.started')) {
      expect(payload).toHaveProperty(key);
    }
  });
});

describe('topic catalog', () => {
  it('every emitted topic is declared in the manifest', () => {
    const declaredTopics = manifest.events.map((e) => e.topic);
    for (const t of ELEVENLABS_EVENT_TOPICS) {
      expect(declaredTopics).toContain(t);
    }
    expect(declaredTopics).toHaveLength(ELEVENLABS_EVENT_TOPICS.length);
  });

  it('post_call_transcription declares the nested webhook shape', () => {
    const keys = declared('elevenlabs.post_call_transcription');
    // Spot-check the fields the spec calls out (20261018_voice-events.md §3.2)
    expect(keys).toContain('data.conversation_id');
    expect(keys).toContain('data.agent_id');
    expect(keys).toContain('data.status');
    expect(keys).toContain('data.transcript');
    expect(keys).toContain('data.analysis.transcript_summary');
    expect(keys).toContain('data.analysis.call_successful');
    expect(keys).toContain('data.metadata.call_duration_secs');
    expect(keys).toContain('data.metadata.termination_reason');
    expect(keys).toContain('data.metadata.cost');
  });

  it('every declared topic passes the namespacing regex', () => {
    const regex = /^[a-z0-9]+(?:[._:][a-z0-9_]+)+$/;
    for (const e of manifest.events) {
      expect(regex.test(e.topic)).toBe(true);
    }
  });

  it('descriptions fit the 300-char schema cap', () => {
    for (const e of manifest.events) {
      if (e.description) expect(e.description.length).toBeLessThanOrEqual(300);
    }
  });
});
