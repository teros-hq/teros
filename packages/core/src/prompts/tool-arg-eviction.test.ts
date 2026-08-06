/**
 * Unit tests for the TER-707 / CTX-016 tool-arg elision helper. Each test
 * pins a specific mutation of the implementation to red (documented inline);
 * see the PR description for the survivor-hunt log.
 */

import { describe, expect, it } from 'bun:test';
import type { MessageWithParts, ToolPart, ToolState } from '../session/types';
import {
  buildElisionMarker,
  evictOversizedToolArgs,
  isEvictedToolArgs,
  projectToolInput,
  splitAtCodePointBoundary,
  TOOL_ARG_EVICTION_THRESHOLD_CHARS,
  TOOL_ARG_VALUE_RETAIN_CHARS,
} from './tool-arg-eviction';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function completed(input: unknown, extra?: Partial<Record<string, unknown>>): ToolState {
  return {
    status: 'completed',
    input: input as Record<string, any>,
    output: 'ok',
    title: 't',
    metadata: {},
    time: { start: 0, end: 1 },
    ...(extra as any),
  } as ToolState;
}

function errored(input: unknown): ToolState {
  return {
    status: 'error',
    input: input as Record<string, any>,
    error: 'boom',
    time: { start: 0, end: 1 },
  };
}

function pendingState(input?: unknown): ToolState {
  return { status: 'pending', input: input as any };
}

function runningState(input: unknown): ToolState {
  return { status: 'running', input: input as any, time: { start: 0 } };
}

function pendingApprovalState(input: unknown): ToolState {
  return {
    status: 'pending_approval',
    input: input as any,
    time: { start: 0 },
    permissionRequest: { requestId: 'r', appId: 'a', toolName: 't', createdAt: 0 },
  };
}

function toolPart(opts: {
  id?: string;
  callID?: string;
  tool?: string;
  state: ToolState;
  metadata?: Record<string, any>;
}): ToolPart {
  return {
    id: opts.id ?? 'part_1',
    sessionID: 'session_1',
    messageID: 'message_1',
    type: 'tool',
    tool: opts.tool ?? 'filesystem_write',
    callID: opts.callID ?? 'call_1',
    state: opts.state,
    metadata: opts.metadata,
  };
}

function assistantMessage(id: string, parts: ToolPart[]): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'session_1',
      role: 'assistant',
      time: { created: 0 },
      system: [],
      modelID: 'm',
      providerID: 'p',
      mode: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

// ---------------------------------------------------------------------------
// U1 — trigger boundary
// ---------------------------------------------------------------------------

describe('projectToolInput — trigger boundary (U1)', () => {
  it('input serializing to exactly the threshold is untouched; threshold+1 is projected', () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const atN = TOOL_ARG_EVICTION_THRESHOLD_CHARS - overhead;
    const atInput = { body: 'x'.repeat(atN) };
    expect(JSON.stringify(atInput).length).toBe(TOOL_ARG_EVICTION_THRESHOLD_CHARS);

    const atResult = projectToolInput(atInput);
    expect(atResult.eviction).toBeUndefined();
    expect(atResult.input).toBe(atInput);

    const overInput = { body: 'x'.repeat(atN + 1) };
    const overResult = projectToolInput(overInput);
    expect(overResult.eviction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// U2 — exact by-value elision
// ---------------------------------------------------------------------------

describe('projectToolInput — by-value elision (U2)', () => {
  it('elides only the oversized value; short keys/values survive whole', () => {
    const input = { path: '/a.ts', content: 'y'.repeat(100_000) };
    const result = projectToolInput(input);

    expect(result.eviction?.mode).toBe('values');
    expect(result.eviction?.valuesElided).toBe(1);
    expect(result.input).toEqual({
      path: '/a.ts',
      content: 'y'.repeat(TOOL_ARG_VALUE_RETAIN_CHARS) + buildElisionMarker(100_000),
    });
  });
});

// ---------------------------------------------------------------------------
// U3 — surrogate-safe cut
// ---------------------------------------------------------------------------

describe('splitAtCodePointBoundary / projection — surrogate safety (U3)', () => {
  it('splitAtCodePointBoundary never leaves a lone high surrogate', () => {
    const emoji = '\u{1F600}'; // U+1F600, surrogate pair
    const filler = 'a'.repeat(TOOL_ARG_VALUE_RETAIN_CHARS - 1);
    const str = filler + emoji + 'b'.repeat(1000);
    const cut = splitAtCodePointBoundary(str, TOOL_ARG_VALUE_RETAIN_CHARS);
    expect(cut).toBe(filler); // backs off before the surrogate pair entirely
    const lastCode = cut.charCodeAt(cut.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it('a value straddling a surrogate pair at the cut point still round-trips as valid JSON', () => {
    const emoji = '\u{1F600}';
    const filler = 'a'.repeat(TOOL_ARG_VALUE_RETAIN_CHARS - 1);
    const longValue = filler + emoji + 'b'.repeat(50_000);
    const result = projectToolInput({ v: longValue });
    expect(() => JSON.parse(JSON.stringify(result.input))).not.toThrow();
  });

  it('quotes, backslashes and newlines in the retained head still produce valid JSON', () => {
    const tricky = `"quoted"\\backslash\nline\r\ttab` + 'x'.repeat(50_000);
    const result = projectToolInput({ v: tricky });
    const roundTripped = JSON.parse(JSON.stringify(result.input));
    expect(roundTripped.v).toBe((result.input as any).v);
  });
});

// ---------------------------------------------------------------------------
// U4 — deep copy-on-write
// ---------------------------------------------------------------------------

describe('projectToolInput — copy-on-write (U4)', () => {
  it('never mutates the original input; only the modified branch is a new object', () => {
    const original = { path: '/a.ts', nested: { content: 'z'.repeat(50_000), other: 'kept' } };
    const snapshot = JSON.parse(JSON.stringify(original));

    const result = projectToolInput(original);

    expect(original).toEqual(snapshot);
    expect(result.input).not.toBe(original);
    const resultObj = result.input as any;
    expect(resultObj.nested).not.toBe(original.nested);
  });
});

// ---------------------------------------------------------------------------
// U5 — referential identity / aliasing
// ---------------------------------------------------------------------------

describe('evictOversizedToolArgs — referential identity (U5)', () => {
  it('untouched messages/parts keep the same reference; aliased fields on a modified part stay aliased', () => {
    const untouchedPart = toolPart({ callID: 'call_small', state: completed({ path: '/small.ts' }) });
    const msgUntouched = assistantMessage('msg_1', [untouchedPart]);

    const attachments = [{ type: 'file' }] as any;
    const time = { start: 0, end: 1 };
    const metadata = { foo: 'bar' };
    const bigState = {
      status: 'completed',
      input: { path: '/big.ts', body: 'q'.repeat(50_000) },
      output: 'ok',
      title: 't',
      metadata,
      time,
      attachments,
    } as ToolState;
    const bigPart = toolPart({ callID: 'call_big', state: bigState });
    const msgAffected = assistantMessage('msg_2', [bigPart]);

    const { messages } = evictOversizedToolArgs([msgUntouched, msgAffected]);

    expect(messages[0]).toBe(msgUntouched);
    const newPart = messages[1].parts[0] as ToolPart;
    expect(newPart).not.toBe(bigPart);
    expect((newPart.state as any).attachments).toBe(attachments);
    expect((newPart.state as any).time).toBe(time);
    expect((newPart.state as any).metadata).toBe(metadata);
  });
});

// ---------------------------------------------------------------------------
// U6 — structural invariant
// ---------------------------------------------------------------------------

describe('evictOversizedToolArgs — structural invariant (U6)', () => {
  it('preserves array length, ids, callID, status, output, metadata — only long input values change', () => {
    const bigPart = toolPart({
      id: 'part_x',
      callID: 'call_x',
      tool: 'filesystem_write',
      state: completed({ path: '/f.ts', body: 'w'.repeat(50_000) }),
    });
    const msg = assistantMessage('msg_1', [bigPart]);

    const { messages } = evictOversizedToolArgs([msg]);
    const newPart = messages[0].parts[0] as ToolPart;

    expect(messages[0].parts.length).toBe(1);
    expect(newPart.id).toBe(bigPart.id);
    expect(newPart.callID).toBe(bigPart.callID);
    expect(newPart.tool).toBe(bigPart.tool);
    expect(newPart.state.status).toBe('completed');
    expect((newPart.state as any).output).toBe((bigPart.state as any).output);
    expect((newPart.state as any).metadata).toEqual((bigPart.state as any).metadata);
  });
});

// ---------------------------------------------------------------------------
// U7 — idempotency
// ---------------------------------------------------------------------------

describe('projectToolInput — idempotency (U7)', () => {
  it('short-circuits on the discriminant, independent of thresholdChars', () => {
    const massiveArray = Array.from({ length: 5000 }, (_, i) => i);
    const first = projectToolInput(massiveArray);
    expect(first.eviction?.mode).toBe('fallback-sentinel');
    expect(isEvictedToolArgs(first.input)).toBe(true);

    // Threshold lowered far below the sentinel's own size: a by-size check
    // would re-trigger; the discriminant short-circuit must win instead.
    const second = projectToolInput(first.input, { thresholdChars: 100 });
    expect(second.input).toBe(first.input);
    expect(second.eviction).toBeUndefined();
  });

  it('by-value elision converges: evict(evict(x)) is a no-op', () => {
    const input = { path: '/a.ts', content: 'v'.repeat(50_000) };
    const once = projectToolInput(input);
    const twice = projectToolInput(once.input);
    expect(twice.input).toEqual(once.input);
    expect(twice.eviction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U8 — states
// ---------------------------------------------------------------------------

describe('evictOversizedToolArgs — states (U8)', () => {
  it('pending/running/pending_approval with big input get projected; pending w/o input and error are untouched', () => {
    const big = { body: 'x'.repeat(50_000) };
    const msgs: MessageWithParts[] = [
      assistantMessage('m1', [toolPart({ callID: 'c1', state: pendingState() })]),
      assistantMessage('m2', [toolPart({ callID: 'c2', state: runningState(big) })]),
      assistantMessage('m3', [toolPart({ callID: 'c3', state: pendingApprovalState(big) })]),
      assistantMessage('m4', [toolPart({ callID: 'c4', state: errored(big) })]),
    ];

    const { messages, evictions } = evictOversizedToolArgs(msgs);

    expect(messages[0]).toBe(msgs[0]);
    expect(messages[1]).not.toBe(msgs[1]);
    expect(messages[2]).not.toBe(msgs[2]);
    expect(messages[3]).toBe(msgs[3]); // E1 — error is exempt

    expect(evictions.map((e) => e.callID).sort()).toEqual(['c2', 'c3']);
  });
});

// ---------------------------------------------------------------------------
// U9 — Gemini signature exemption
// ---------------------------------------------------------------------------

describe('evictOversizedToolArgs — E2 thoughtSignature exemption (U9)', () => {
  it('a signed part stays untouched even with a huge input', () => {
    const bigSignedPart = toolPart({
      callID: 'call_signed',
      state: completed({ body: 'x'.repeat(100_000) }),
      metadata: { thoughtSignature: 'sig-abc' },
    });
    const msg = assistantMessage('m1', [bigSignedPart]);

    const { messages, evictions } = evictOversizedToolArgs([msg]);

    expect(messages[0]).toBe(msg);
    expect(evictions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U10 — fallback sentinel
// ---------------------------------------------------------------------------

describe('projectToolInput — fallback sentinel (U10)', () => {
  it('mass in structure (not strings) falls back to the sentinel-object, bound holds', () => {
    const bulkArray = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const result = projectToolInput({ items: bulkArray });

    expect(result.eviction?.mode).toBe('fallback-sentinel');
    expect(isEvictedToolArgs(result.input)).toBe(true);
    expect(JSON.stringify(result.input).length).toBeLessThanOrEqual(TOOL_ARG_EVICTION_THRESHOLD_CHARS);
  });
});

// ---------------------------------------------------------------------------
// U11 — cyclic input
// ---------------------------------------------------------------------------

describe('projectToolInput — cyclic input (U11)', () => {
  it('never throws; falls back to a sentinel with originalChars -1', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;

    const result = projectToolInput(cyclic);

    expect(result.eviction?.mode).toBe('non-serializable');
    expect(result.eviction?.originalChars).toBe(-1);
    expect(isEvictedToolArgs(result.input)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U12 — strict discriminant guard
// ---------------------------------------------------------------------------

describe('isEvictedToolArgs / elision — strict guard, safe failure direction (U12)', () => {
  it('an oversized-preview impostor fails the guard and GETS projected', () => {
    const impostor = {
      __terosEvicted: 'tool-args',
      __originalChars: 5,
      __note: 'x',
      __preview: 'y'.repeat(500_000),
    };
    expect(isEvictedToolArgs(impostor)).toBe(false);

    const result = projectToolInput(impostor);
    expect(result.eviction).toBeDefined();
  });

  it('a genuinely huge string ending in a marker-lookalike is still elided', () => {
    const markerLookalikeTail = buildElisionMarker(9);
    const genuinelyHuge = 'z'.repeat(50_000) + markerLookalikeTail;

    const result = projectToolInput({ v: genuinelyHuge });
    const projectedV = (result.input as any).v;

    expect(projectedV).not.toBe(genuinelyHuge);
    expect(result.eviction?.valuesElided).toBe(1);
  });

  it('a well-formed impostor with a small preview short-circuits (harmless no-op)', () => {
    const wellFormed = { __terosEvicted: 'tool-args', __originalChars: 5, __note: 'x', __preview: 'y' };
    expect(isEvictedToolArgs(wellFormed)).toBe(true);
    const result = projectToolInput(wellFormed);
    expect(result.input).toBe(wellFormed);
    expect(result.eviction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U13 — value-level boundary
// ---------------------------------------------------------------------------

describe('elision — value-level boundary (U13)', () => {
  it('a value of exactly retain+markerLen chars is untouched; +1 IS elided; elision always shrinks', () => {
    let n = TOOL_ARG_VALUE_RETAIN_CHARS + buildElisionMarker(TOOL_ARG_VALUE_RETAIN_CHARS + 50).length;
    for (let i = 0; i < 5; i++) {
      n = TOOL_ARG_VALUE_RETAIN_CHARS + buildElisionMarker(n).length;
    }

    const atBoundary = 'a'.repeat(n);
    const overBoundary = 'a'.repeat(n + 1);
    // A filler forces the WHOLE input over threshold so elideValue actually
    // runs — a lone ~2K-char field never trips the 20K outer trigger.
    const bigFiller = 'x'.repeat(30_000);

    const atResult = projectToolInput({ big: bigFiller, probe: atBoundary });
    expect((atResult.input as any).probe).toBe(atBoundary);

    const overResult = projectToolInput({ big: bigFiller, probe: overBoundary });
    const overProbe = (overResult.input as any).probe as string;
    expect(overProbe).not.toBe(overBoundary);
    expect(overProbe.length).toBeLessThan(overBoundary.length);
  });
});

// ---------------------------------------------------------------------------
// isEvictedToolArgs — misc guard shapes
// ---------------------------------------------------------------------------

describe('isEvictedToolArgs — shape guard', () => {
  it('rejects null, arrays, and objects with the wrong key count/types', () => {
    expect(isEvictedToolArgs(null)).toBe(false);
    expect(isEvictedToolArgs(undefined)).toBe(false);
    expect(isEvictedToolArgs([])).toBe(false);
    expect(isEvictedToolArgs({ __terosEvicted: 'tool-args' })).toBe(false);
    expect(
      isEvictedToolArgs({
        __terosEvicted: 'tool-args',
        __originalChars: 'not-a-number',
        __note: 'x',
        __preview: 'y',
      }),
    ).toBe(false);
  });
});
