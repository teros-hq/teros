/**
 * StreamPublisher tests — covers turn-redesign additions:
 * publishQueueStateChange, publishAgentPhase dedup, cleanupSession,
 * and the publishTextChunk throttle path.
 */

import { describe, expect, it } from 'bun:test';
import { StreamPublisher } from './StreamPublisher';
import type { AgentPhaseMessage, QueueStateMessage, StreamEvent, TextChunkMessage } from './types';

const SESSION = 'ch_session_1';
const CHANNEL = 'ch_channel_1';
const USER = 'user_alice';
const THREAD = 1;

function capture(p: StreamPublisher): StreamEvent[] {
  const events: StreamEvent[] = [];
  p.onStream((e) => {
    events.push(e);
  });
  return events;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('StreamPublisher', () => {
  describe('publishTextChunk', () => {
    it('happy path: subscriber receives a text_chunk event with the text', async () => {
      const p = new StreamPublisher('agent_1', { throttleMs: 10, maxChunkSize: 1 });
      const events = capture(p);

      p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'Hello');
      // maxChunkSize=1 forces an immediate flush — no wait needed.

      const textEvents = events.filter((e) => e.message.type === 'text_chunk');
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      const msg = textEvents[0].message as TextChunkMessage;
      expect(msg.text).toBe('Hello');
      expect(textEvents[0].channelId).toBe(CHANNEL);
      expect(textEvents[0].userId).toBe(USER);
    });

    it('throttle: 5 rapid chunks buffer into <5 emitted events; flushes after throttleMs*2', async () => {
      const p = new StreamPublisher('agent_1', { throttleMs: 40, maxChunkSize: 999 });
      const events = capture(p);

      for (let i = 0; i < 5; i++) p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'x');

      const burstCount = events.filter((e) => e.message.type === 'text_chunk').length;
      expect(burstCount).toBeLessThan(5);

      await wait(120);
      const afterCount = events.filter((e) => e.message.type === 'text_chunk').length;
      expect(afterCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('publishQueueStateChange', () => {
    it('emits the 3 states; assistantId only present on done', () => {
      const p = new StreamPublisher('agent_1');
      const events = capture(p);

      p.publishQueueStateChange(CHANNEL, USER, 'msg_1', 'pending', THREAD);
      p.publishQueueStateChange(CHANNEL, USER, 'msg_1', 'running', THREAD);
      p.publishQueueStateChange(CHANNEL, USER, 'msg_1', 'done', THREAD, 'asst_42');

      const qs = events
        .filter((e) => e.message.type === 'queue_state')
        .map((e) => e.message as QueueStateMessage);
      expect(qs.map((m) => m.state)).toEqual(['pending', 'running', 'done']);
      // Frontend uses assistantId only on done — pending/running must not carry it.
      expect((qs[0] as any).assistantId).toBeUndefined();
      expect((qs[1] as any).assistantId).toBeUndefined();
      expect((qs[2] as any).assistantId).toBe('asst_42');
    });

    it('done without assistantId omits the field entirely', () => {
      const p = new StreamPublisher('agent_1');
      const events = capture(p);
      p.publishQueueStateChange(CHANNEL, USER, 'msg_1', 'done', THREAD);

      const msg = events[0].message as QueueStateMessage;
      expect(msg.state).toBe('done');
      expect((msg as any).assistantId).toBeUndefined();
    });
  });

  describe('publishAgentPhase', () => {
    it('dedupes per-channel: back-to-back same phase → 1 event', () => {
      const p = new StreamPublisher('agent_1');
      const events = capture(p);

      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);

      const phases = events.filter((e) => e.message.type === 'agent_phase');
      expect(phases.length).toBe(1);
    });

    it('phase change emits a fresh event', () => {
      const p = new StreamPublisher('agent_1');
      const events = capture(p);

      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
      p.publishAgentPhase(CHANNEL, USER, 'executing_tool', THREAD);
      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);

      const phases = events
        .filter((e) => e.message.type === 'agent_phase')
        .map((e) => (e.message as AgentPhaseMessage).phase);
      expect(phases).toEqual(['thinking', 'executing_tool', 'thinking']);
    });

    it('different channels do not dedupe against each other', () => {
      const p = new StreamPublisher('agent_1');
      const events = capture(p);

      p.publishAgentPhase('ch_A', USER, 'thinking');
      p.publishAgentPhase('ch_B', USER, 'thinking');

      const phases = events.filter((e) => e.message.type === 'agent_phase');
      expect(phases.length).toBe(2);
      expect(phases.map((e) => e.channelId).sort()).toEqual(['ch_A', 'ch_B']);
    });
  });

  describe('getAgentPhase', () => {
    it('returns the last-published phase for the channel', () => {
      const p = new StreamPublisher('agent_1');
      expect(p.getAgentPhase(CHANNEL)).toBeUndefined();

      p.publishAgentPhase(CHANNEL, USER, 'thinking');
      expect(p.getAgentPhase(CHANNEL)).toBe('thinking');

      p.publishAgentPhase(CHANNEL, USER, 'executing_tool');
      expect(p.getAgentPhase(CHANNEL)).toBe('executing_tool');
    });

    it('returns undefined for an unknown channel', () => {
      const p = new StreamPublisher('agent_1');
      p.publishAgentPhase('ch_other', USER, 'thinking');
      expect(p.getAgentPhase('ch_unknown')).toBeUndefined();
    });
  });

  describe('cleanupSession', () => {
    it('clears the dedup baseline so getAgentPhase returns undefined after cleanup', () => {
      const p = new StreamPublisher('agent_1');
      // The dedup Map key is the channelId; cleanupSession uses sessionId as the key for deletion.
      // The handler aligns them (sessionId === channelId in queue_state), so we use the same id.
      p.publishAgentPhase(CHANNEL, USER, 'thinking');
      expect(p.getAgentPhase(CHANNEL)).toBe('thinking');

      p.cleanupSession(CHANNEL);
      expect(p.getAgentPhase(CHANNEL)).toBeUndefined();
    });

    it('also clears text buffer + flush timer for the session', async () => {
      const p = new StreamPublisher('agent_1', { throttleMs: 40, maxChunkSize: 999 });
      const events = capture(p);

      p.publishTextChunk(SESSION, CHANNEL, USER, THREAD, 'buffered');
      p.cleanupSession(SESSION);
      await wait(120);

      const textEvents = events.filter((e) => e.message.type === 'text_chunk');
      // Buffer was dropped, no scheduled flush should fire.
      expect(textEvents.length).toBe(0);
    });

    it('cleanupSession with explicit channelId clears currentAgentPhase keyed by channelId', () => {
      const p = new StreamPublisher('agent_1');
      // sessionId !== channelId — the phase Map is keyed by channelId only.
      p.publishAgentPhase('ch_1', USER, 'thinking', THREAD);
      expect(p.getAgentPhase('ch_1')).toBe('thinking');
      p.cleanupSession('sess_1', 'ch_1');
      expect(p.getAgentPhase('ch_1')).toBeUndefined();
    });

    it('cleanupSession without channelId falls back to sessionId (legacy)', () => {
      const p = new StreamPublisher('agent_1');
      // Legacy: sessionId === channelId. Single-arg call must still clear phase.
      p.publishAgentPhase(CHANNEL, USER, 'thinking', THREAD);
      expect(p.getAgentPhase(CHANNEL)).toBe('thinking');
      p.cleanupSession(CHANNEL);
      expect(p.getAgentPhase(CHANNEL)).toBeUndefined();
    });
  });
});
