/**
 * PromptBuilder tests — cache breakpoint (mod-N strategy)
 *
 * Tests verify that:
 * 1. The breakpoint does NOT move between messages within the same block
 * 2. The breakpoint DOES move when crossing a block boundary
 * 3. The feature flag (cacheBlockSize=0) falls back to legacy behavior
 * 4. Edge cases: no messages, fewer than one block, exactly one block, etc.
 */

import { describe, expect, it } from 'vitest';
import { buildPrompt } from './PromptBuilder';
import type { MessageWithParts } from '../session/types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMessage(role: 'user' | 'assistant', text: string, index: number): MessageWithParts {
  const id = `msg-${index}`;
  return {
    info: {
      id,
      sessionID: 'test-session',
      role,
      time: { created: Date.now() },
    } as any,
    parts: [
      {
        id: `${id}-part`,
        sessionID: 'test-session',
        messageID: id,
        type: 'text',
        text,
        time: { start: Date.now(), end: Date.now() },
      } as any,
    ],
  };
}

/**
 * Build an array of alternating user/assistant messages.
 */
function makeMessages(count: number): MessageWithParts[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i),
  );
}

const BASE_COMPONENTS = {
  system: 'You are a helpful assistant.',
  messages: [] as MessageWithParts[],
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PromptBuilder — mod-N cache breakpoint strategy', () => {
  describe('breakpoint stability within a block', () => {
    it('should return the same cacheBreakpointIndex for consecutive messages within the same block', () => {
      // With latestMessageCount=20 and blockSize=20:
      // messages 21..39 → previousMessages = 1..19 → snapped = floor(N/20)*20 = 0 → no breakpoint yet
      // messages 41..59 → previousMessages = 21..39 → snapped = floor(N/20)*20 = 20 → stable at 19
      //
      // Simpler test: with blockSize=5 and latestMessageCount=5
      // messages 6..9  → previous = 1..1..4 → snapped = 0 → breakpoint = -1
      // messages 11..14 → previous = 6..9 → snapped = floor(4/5)*5 = 0 → breakpoint = -1
      // messages 10 → previous = 5 → snapped = floor(5/5)*5 = 5 → breakpoint at msg 4

      const BLOCK = 5;
      const LATEST = 5;

      // At 10 total messages: previous=5, snapped=5 → breakpoint exists
      const result10 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(10) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      // At 11 total messages: previous=6, snapped=floor(6/5)*5=5 → same snapped count
      const result11 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(11) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      // At 14 total messages: previous=9, snapped=floor(9/5)*5=5 → same snapped count
      const result14 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(14) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      // All three should produce the same cacheBreakpointIndex (stable within block)
      expect(result10.metadata.cacheBreakpointIndex).toBe(result11.metadata.cacheBreakpointIndex);
      expect(result10.metadata.cacheBreakpointIndex).toBe(result14.metadata.cacheBreakpointIndex);
      expect(result10.metadata.cacheBreakpointIndex).toBeGreaterThanOrEqual(0);
    });

    it('should NOT move the breakpoint as messages accumulate within a block (default blockSize=20)', () => {
      const LATEST = 20;

      // At 40 messages: previous=20, snapped=20 → breakpoint at index 19
      const at40 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(40) },
        { latestMessageCount: LATEST },
      );

      // At 45 messages: previous=25, snapped=floor(25/20)*20=20 → same breakpoint
      const at45 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(45) },
        { latestMessageCount: LATEST },
      );

      // At 59 messages: previous=39, snapped=floor(39/20)*20=20 → same breakpoint
      const at59 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(59) },
        { latestMessageCount: LATEST },
      );

      expect(at40.metadata.cacheBreakpointIndex).toBe(at45.metadata.cacheBreakpointIndex);
      expect(at40.metadata.cacheBreakpointIndex).toBe(at59.metadata.cacheBreakpointIndex);
    });
  });

  describe('breakpoint advances at block boundaries', () => {
    it('should advance the breakpoint when crossing a block boundary', () => {
      const BLOCK = 5;
      const LATEST = 5;

      // At 10 messages: previous=5, snapped=5 → breakpoint at index 4
      const atBlock1 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(10) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      // At 15 messages: previous=10, snapped=10 → breakpoint at index 9
      const atBlock2 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(15) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      // At 20 messages: previous=15, snapped=15 → breakpoint at index 14
      const atBlock3 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(20) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      expect(atBlock2.metadata.cacheBreakpointIndex).toBeGreaterThan(
        atBlock1.metadata.cacheBreakpointIndex,
      );
      expect(atBlock3.metadata.cacheBreakpointIndex).toBeGreaterThan(
        atBlock2.metadata.cacheBreakpointIndex,
      );
    });

    it('should advance by exactly blockSize at each boundary', () => {
      const BLOCK = 5;
      const LATEST = 5;

      const atBlock1 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(10) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );
      const atBlock2 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(15) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      const diff =
        atBlock2.metadata.cacheBreakpointIndex - atBlock1.metadata.cacheBreakpointIndex;
      expect(diff).toBe(BLOCK);
    });
  });

  describe('edge cases', () => {
    it('should return -1 when there are no previous messages (fewer than one block)', () => {
      const BLOCK = 20;
      const LATEST = 20;

      // 15 messages total → previous=0 → no cache breakpoint
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(15) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      expect(result.metadata.cacheBreakpointIndex).toBe(-1);
    });

    it('should return -1 when there are no messages at all', () => {
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: [] },
        { latestMessageCount: 20, cacheBlockSize: 20 },
      );

      expect(result.metadata.cacheBreakpointIndex).toBe(-1);
    });

    it('should return -1 when previous messages exist but none fill a full block', () => {
      const BLOCK = 10;
      const LATEST = 5;

      // 12 messages → previous=7, snapped=floor(7/10)*10=0 → no breakpoint
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(12) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      expect(result.metadata.cacheBreakpointIndex).toBe(-1);
    });

    it('should produce a valid breakpoint exactly at one block boundary', () => {
      const BLOCK = 10;
      const LATEST = 5;

      // 15 messages → previous=10, snapped=10 → breakpoint at index 9
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(15) },
        { latestMessageCount: LATEST, cacheBlockSize: BLOCK },
      );

      expect(result.metadata.cacheBreakpointIndex).toBeGreaterThanOrEqual(0);
      expect(result.metadata.cacheBlockSize).toBe(BLOCK);
    });
  });

  describe('feature flag — cacheBlockSize=0 (legacy mode)', () => {
    it('should use legacy moving breakpoint when cacheBlockSize=0', () => {
      const LATEST = 5;

      // With legacy mode, breakpoint = builtMessages.length - 1 (last previous msg)
      // so it moves with every new message
      const at10 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(10) },
        { latestMessageCount: LATEST, cacheBlockSize: 0 },
      );

      const at11 = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(11) },
        { latestMessageCount: LATEST, cacheBlockSize: 0 },
      );

      // In legacy mode the breakpoint moves with each new message
      expect(at11.metadata.cacheBreakpointIndex).toBeGreaterThan(
        at10.metadata.cacheBreakpointIndex,
      );
      expect(at10.metadata.cacheBlockSize).toBe(0);
    });

    it('should set cacheBlockSize=0 in metadata when legacy mode is used', () => {
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(10) },
        { latestMessageCount: 5, cacheBlockSize: 0 },
      );

      expect(result.metadata.cacheBlockSize).toBe(0);
    });
  });

  describe('metadata', () => {
    it('should include cacheBlockSize in metadata', () => {
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(40) },
        { latestMessageCount: 20, cacheBlockSize: 20 },
      );

      expect(result.metadata.cacheBlockSize).toBe(20);
    });

    it('should default to cacheBlockSize=20 when not specified', () => {
      const result = buildPrompt(
        { ...BASE_COMPONENTS, messages: makeMessages(40) },
        { latestMessageCount: 20 },
      );

      // When mod-N fires, effectiveCacheBlockSize = blockSize (20)
      expect(result.metadata.cacheBlockSize).toBe(20);
    });
  });
});
