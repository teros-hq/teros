/**
 * Flatten del payload post_call_transcription (VOICE-NOTIFY-1 / P2 del spec
 * voice-events §3.2 "Payload anidado").
 *
 * El webhook de ElevenLabs llega anidado bajo data.*; los consumidores del bus
 * (rulesMatch de suscripciones, filtros Automate) comparan campos TOP-LEVEL.
 * Estos tests fijan: aliases correctos, compatibilidad (data.* intacto), y el
 * gate por mcaId+eventType. El catálogo (manifest.json) y POST_CALL_FLAT_FIELDS
 * quedan pineados entre sí para que no puedan divergir.
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'bun:test';
import {
  POST_CALL_FLAT_FIELDS,
  flattenElevenLabsPostCallPayload,
  isElevenLabsPostCallEvent,
} from '../../src/lib/flatten-elevenlabs-payload';

const manifest = JSON.parse(
  readFileSync(new URL('../../../../mcas/mca.elevenlabs/manifest.json', import.meta.url), 'utf8'),
) as { events: Array<{ topic: string; payload: Record<string, string> }> };

const REALISTIC = {
  type: 'post_call_transcription',
  event_timestamp: 1729534477,
  data: {
    agent_id: 'agent_abc123',
    conversation_id: 'conv_xyz789',
    status: 'done',
    transcript: [{ role: 'user', message: 'hola', time_in_call_secs: 2 }],
    analysis: {
      transcript_summary: 'El usuario confirmó la cita del martes.',
      call_successful: 'success',
    },
    metadata: {
      call_duration_secs: 47,
      termination_reason: 'user_hangup',
      cost: 312,
    },
  },
};

describe('flattenElevenLabsPostCallPayload', () => {
  it('projects every nested field onto its flat alias', () => {
    const out = flattenElevenLabsPostCallPayload(REALISTIC as unknown as Record<string, unknown>);

    expect(out.conversationId).toBe('conv_xyz789');
    expect(out.agentId).toBe('agent_abc123');
    expect(out.status).toBe('done');
    expect(out.transcriptSummary).toBe('El usuario confirmó la cita del martes.');
    expect(out.callSuccessful).toBe('success');
    expect(out.durationSecs).toBe(47);
    expect(out.terminationReason).toBe('user_hangup');
    expect(out.cost).toBe(312);
  });

  it('keeps the nested data.* shape intact (compat with {{data.conversation_id}} templates)', () => {
    const out = flattenElevenLabsPostCallPayload(REALISTIC as unknown as Record<string, unknown>);

    const data = out.data as any;
    expect(data.conversation_id).toBe('conv_xyz789');
    expect(data.analysis.transcript_summary).toBe('El usuario confirmó la cita del martes.');
    expect(data.metadata.call_duration_secs).toBe(47);
    expect(out.type).toBe('post_call_transcription');
    expect(out.event_timestamp).toBe(1729534477);
  });

  it('does not mutate the input payload', () => {
    const input = JSON.parse(JSON.stringify(REALISTIC));
    flattenElevenLabsPostCallPayload(input);
    expect((input as any).conversationId).toBeUndefined();
    expect((input as any).data.conversation_id).toBe('conv_xyz789');
  });

  it('skips aliases whose nested source is missing (no fabricated nulls)', () => {
    const out = flattenElevenLabsPostCallPayload({
      type: 'post_call_transcription',
      data: { conversation_id: 'conv_1' },
    });
    expect(out.conversationId).toBe('conv_1');
    expect(out).not.toHaveProperty('transcriptSummary');
    expect(out).not.toHaveProperty('callSuccessful');
    expect(out).not.toHaveProperty('cost');
  });

  it('nested value wins over a pre-existing same-named top-level key', () => {
    const out = flattenElevenLabsPostCallPayload({
      data: { conversation_id: 'conv_real' },
      conversationId: 'conv_stale',
    });
    expect(out.conversationId).toBe('conv_real');
  });
});

describe('isElevenLabsPostCallEvent (gate)', () => {
  it('matches only mca.elevenlabs + post_call_transcription', () => {
    expect(isElevenLabsPostCallEvent('mca.elevenlabs', 'post_call_transcription')).toBe(true);
    expect(isElevenLabsPostCallEvent('mca.elevenlabs', 'call_initiation_failure')).toBe(false);
    expect(isElevenLabsPostCallEvent('mca.intercom', 'post_call_transcription')).toBe(false);
  });
});

describe('drift guard — manifest catalog ↔ POST_CALL_FLAT_FIELDS', () => {
  it('every flat alias is declared in the manifest payload map', () => {
    const declared = Object.keys(
      manifest.events.find((e) => e.topic === 'elevenlabs.post_call_transcription')!.payload,
    );
    for (const alias of Object.values(POST_CALL_FLAT_FIELDS)) {
      expect(declared).toContain(alias);
    }
  });

  it('every nested dot-path in POST_CALL_FLAT_FIELDS is declared in the manifest', () => {
    const declared = Object.keys(
      manifest.events.find((e) => e.topic === 'elevenlabs.post_call_transcription')!.payload,
    );
    for (const dotPath of Object.keys(POST_CALL_FLAT_FIELDS)) {
      expect(declared).toContain(dotPath);
    }
  });
});
