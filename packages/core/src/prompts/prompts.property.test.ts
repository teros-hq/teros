/**
 * Property-based tests del subsistema prompts (TER-469, portfolio 2026).
 *
 * Propiedades:
 *  P1. INV-1 postcondición: TODO historial generado (con orphans arbitrarios)
 *      queda INV-1-válido tras detect → synthesizeOrphans sobre un store
 *      upsert fiel a SessionStore.writePart. Además el detector cuenta
 *      exactamente los orphans generados.
 *  P2. Token budget: el breakdown de buildPrompt es siempre de enteros no
 *      negativos, con los invariantes conversation = previous + latest y
 *      toolCalls + toolResults ≤ conversation.
 *  P3. Metamórfica del split: conversation total es independiente de
 *      latestMessageCount (el split mueve tokens entre previous/latest
 *      sin crearlos ni destruirlos).
 *  P4. estimateTokens (heurística ceil chars/4): monotónica y subaditiva
 *      bajo concatenación.
 *
 * La cadena indirecta detect→synthesize→reload vía TurnDriver ya está
 * cubierta en TER-445 (PR #164, test/conversation/TurnDriver.test.ts);
 * aquí va la red DIRECTA del invariante.
 */

import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { synthesizeOrphans } from '../conversation/MessageProcessor';
import type { SessionStore } from '../session/SessionStore';
import type { MessageWithParts } from '../session/types';
import { assertInvariantINV1, buildPrompt, totalFromBreakdown, PromptBuilder } from './PromptBuilder';

// ─────────────────────────────────────────────────────────────────────────────
// Generadores
// ─────────────────────────────────────────────────────────────────────────────

type ToolStatus = 'pending' | 'running' | 'pending_approval' | 'completed' | 'error';

type PartSpec = { kind: 'text'; text: string } | { kind: 'tool'; status: ToolStatus };
type MsgSpec = { role: 'user' | 'assistant'; parts: PartSpec[] };

const arbPartSpec: fc.Arbitrary<PartSpec> = fc.oneof(
  fc.record({ kind: fc.constant('text' as const), text: fc.string({ maxLength: 30 }) }),
  fc.record({
    kind: fc.constant('tool' as const),
    status: fc.constantFrom<ToolStatus>(
      'pending',
      'running',
      'pending_approval',
      'completed',
      'error',
    ),
  }),
);

const arbHistorySpec: fc.Arbitrary<MsgSpec[]> = fc.array(
  fc.record({
    role: fc.constantFrom<'user' | 'assistant'>('user', 'assistant'),
    parts: fc.array(arbPartSpec, { maxLength: 4 }),
  }),
  { maxLength: 12 },
);

function mkToolState(status: ToolStatus): any {
  switch (status) {
    case 'pending':
      return { status, input: {} };
    case 'running':
    case 'pending_approval':
      return { status, input: { q: 1 }, time: { start: 100 } };
    case 'completed':
      return { status, input: { q: 1 }, output: 'ok', title: '', metadata: {}, time: { start: 100, end: 200 } };
    case 'error':
      return { status, input: { q: 1 }, error: 'failed', time: { start: 100, end: 200 } };
  }
}

function buildHistory(specs: MsgSpec[]): MessageWithParts[] {
  return specs.map((spec, i) => ({
    info: {
      id: `msg_${i}`,
      sessionID: 'session_prop',
      role: spec.role,
      time: { created: 1_700_000_000_000 + i },
    } as any,
    parts: spec.parts.map((p, j) =>
      p.kind === 'text'
        ? ({
            id: `part_${i}_${j}`,
            sessionID: 'session_prop',
            messageID: `msg_${i}`,
            type: 'text',
            text: p.text,
            time: { start: 1, end: 2 },
          } as any)
        : ({
            id: `part_${i}_${j}`,
            sessionID: 'session_prop',
            messageID: `msg_${i}`,
            type: 'tool',
            tool: 'prop-tool',
            callID: `call_${i}_${j}`,
            state: mkToolState(p.status),
          } as any),
    ),
  }));
}

/** Nº de orphans que el generador ha plantado (la verdad del oráculo). */
function plantedOrphans(specs: MsgSpec[]): number {
  return specs
    .filter((s) => s.role === 'assistant')
    .flatMap((s) => s.parts)
    .filter(
      (p) =>
        p.kind === 'tool' &&
        (p.status === 'pending' || p.status === 'running' || p.status === 'pending_approval'),
    ).length;
}

/**
 * Store fake fiel a la semántica de SessionStore.writePart: upsert por
 * part.id dentro del historial vivo.
 */
function mkUpsertStore(history: MessageWithParts[]): SessionStore {
  return {
    writePart: async (part: any) => {
      for (const msg of history) {
        const idx = msg.parts.findIndex((p) => (p as any).id === part.id);
        if (idx >= 0) {
          msg.parts[idx] = part;
          return;
        }
      }
      throw new Error(`upsert miss: part ${part.id} not in history`);
    },
  } as unknown as SessionStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — INV-1 postcondición
// ─────────────────────────────────────────────────────────────────────────────

describe('P1 — INV-1 detect → synthesize → re-detect', () => {
  it('every generated history becomes INV-1-valid after synthesizeOrphans', async () => {
    await fc.assert(
      fc.asyncProperty(arbHistorySpec, async (specs) => {
        const history = buildHistory(specs);

        const before = assertInvariantINV1(history);
        // El detector cuenta exactamente los orphans plantados.
        expect(before.violations.length).toBe(plantedOrphans(specs));
        expect(before.ok).toBe(before.violations.length === 0);

        await synthesizeOrphans(mkUpsertStore(history), 'session_prop', before.violations);

        const after = assertInvariantINV1(history);
        expect(after.ok).toBe(true);
        expect(after.violations.length).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it('synthesized parts are error-status, synthetic-flagged, and preserve callID', async () => {
    await fc.assert(
      fc.asyncProperty(arbHistorySpec, async (specs) => {
        const history = buildHistory(specs);
        const before = assertInvariantINV1(history);
        const orphanCallIDs = before.violations.map((v) => v.toolPart.callID);

        await synthesizeOrphans(mkUpsertStore(history), 'session_prop', before.violations);

        for (const msg of history) {
          if (msg.info.role !== 'assistant') continue;
          for (const part of msg.parts) {
            if ((part as any).type !== 'tool') continue;
            const toolPart = part as any;
            if (orphanCallIDs.includes(toolPart.callID)) {
              expect(toolPart.state.status).toBe('error');
              expect(toolPart.meta?.synthetic).toBe(true);
              expect(toolPart.meta?.syntheticReason).toBe('inv1_recovery');
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — Token budget: no-negatividad + invariantes internos
// ─────────────────────────────────────────────────────────────────────────────

const arbComponents = fc.record({
  system: fc.string({ maxLength: 120 }),
  examples: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
  summary: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
  memory: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
  context: fc.option(fc.record({ channelId: fc.string({ minLength: 1, maxLength: 20 }) }), {
    nil: undefined,
  }),
  historySpec: arbHistorySpec,
});

describe('P2 — token breakdown is non-negative integers with internal invariants', () => {
  it('all breakdown fields are integers ≥ 0; conversation = previous + latest; tool tokens ⊆ conversation', () => {
    fc.assert(
      fc.property(arbComponents, fc.integer({ min: 1, max: 30 }), (c, latestCount) => {
        const built = buildPrompt(
          {
            system: c.system,
            examples: c.examples,
            summary: c.summary,
            memory: c.memory,
            context: c.context,
            messages: buildHistory(c.historySpec),
          },
          { latestMessageCount: latestCount },
        );

        for (const [key, value] of Object.entries(built.breakdown)) {
          expect(Number.isInteger(value)).toBe(true);
          if ((value as number) < 0) throw new Error(`${key} negative: ${value}`);
        }
        // Invariante estructural del split: nada se pierde ni se duplica, y
        // latest es exactamente min(len, latestMessageCount).
        const counts = built.metadata.messageCounts;
        expect(counts.previous + counts.latest).toBe(c.historySpec.length);
        expect(counts.latest).toBe(Math.min(c.historySpec.length, latestCount));
        expect(built.breakdown.conversation).toBe(
          (built.breakdown.previous ?? 0) + (built.breakdown.latest ?? 0),
        );
        expect(
          (built.breakdown.toolCalls ?? 0) + (built.breakdown.toolResults ?? 0),
        ).toBeLessThanOrEqual(built.breakdown.conversation);
        expect(totalFromBreakdown(built.breakdown)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 — Metamórfica: el split no crea ni destruye tokens de conversación
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 — conversation tokens are split-invariant', () => {
  it('breakdown.conversation does not depend on latestMessageCount', () => {
    fc.assert(
      fc.property(
        arbHistorySpec,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 40 }),
        (specs, splitA, splitB) => {
          const a = buildPrompt(
            { system: 'S', messages: buildHistory(specs) },
            { latestMessageCount: splitA },
          );
          const b = buildPrompt(
            { system: 'S', messages: buildHistory(specs) },
            { latestMessageCount: splitB },
          );
          expect(a.breakdown.conversation).toBe(b.breakdown.conversation);
          expect(a.breakdown.toolCalls).toBe(b.breakdown.toolCalls);
          expect(a.breakdown.toolResults).toBe(b.breakdown.toolResults);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — estimateTokens: monotónica y subaditiva (heurística sin provider)
// ─────────────────────────────────────────────────────────────────────────────

describe('P4 — estimateTokens heuristic is monotonic and subadditive', () => {
  it('tokens(s+t) ≥ tokens(s) and tokens(s+t) ≤ tokens(s) + tokens(t)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.string({ maxLength: 200 }), (s, t) => {
        const st = PromptBuilder.estimateTokens(s + t);
        expect(st).toBeGreaterThanOrEqual(PromptBuilder.estimateTokens(s));
        // Subaditividad del ceil; vale también cuando s o t son ''.
        expect(st).toBeLessThanOrEqual(
          PromptBuilder.estimateTokens(s) + PromptBuilder.estimateTokens(t),
        );
      }),
      { numRuns: 300 },
    );
  });
});
