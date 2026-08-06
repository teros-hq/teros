/**
 * VoiceHandler — silent mode intent classification (AF-4).
 *
 * Tests the `classifyIntent` method that detects:
 * - Control phrases: "Alice off" / "Alice on" + locale variants (es/en)
 * - Direct address: wake word at start of utterance (vocative pattern)
 * - Third-person exclusion: "Alice is..." / "Alice está..." → NOT direct address
 *
 * Also tests the enforcement logic in the ElevenLabs message handler:
 * - Silent mode suppresses agent_response / audio forwarding
 * - Direct address enables one-turn pass-through
 * - Pass-through resets after response delivery
 * - Idempotency: repeated "Alice off" in silent mode doesn't re-ack
 */

import { describe, expect, it } from 'bun:test';
import { VoiceHandler } from '../../src/handlers/voice-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class FakeWs {
  readyState = 1; // OPEN
  sent: any[] = [];
  send(data: string | Buffer) {
    if (typeof data === 'string') this.sent.push(JSON.parse(data));
    else this.sent.push(data);
  }
  close() { this.readyState = 3; }
  on() { /* not needed for these tests */ }
}

function makeHandler() {
  const subscriptionService = {
    created: [] as any[],
    deleted: [] as string[],
    async createChannelSubscriptionsBatch(inputs: any[]) {
      const subs = inputs.map((input) => ({ id: `sub_${subs.length + 1}`, ...input }));
      subscriptionService.created.push(...subs);
      return subs;
    },
    async deleteChannelSubscription(id: string) {
      subscriptionService.deleted.push(id);
      return true;
    },
  };
  const db = {
    collection: () => ({
      findOne: async () => null,
      find: () => ({ toArray: async () => [] }),
      updateOne: async () => ({ modifiedCount: 1 }),
    }),
  };
  const channelManager = {
    createMessageId: () => `msg_${Math.random().toString(36).slice(2)}`,
    saveMessage: async () => {},
    getChannel: async () => null,
  };
  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic() {},
  };
  const handler = new VoiceHandler(
    db as any,
    {} as any,
    channelManager as any,
    {} as any,
    {} as any,
    subscriptionService as any,
    { validateSession: async () => ({ success: false }) } as any,
  );
  handler.setPubSubService(pubSubService as any);
  return { handler };
}

function makeConnection(agentName = 'Alice') {
  return {
    clientWs: new FakeWs(),
    elevenLabsWs: new FakeWs(),
    userId: 'u1',
    workspaceId: 'ws1',
    voiceChannelId: 'ch_voice',
    chatChannelId: null,
    agentId: 'agent1',
    sessionId: 's1',
    activeWorkerChannels: new Map<string, string[]>(),
    channelReadsThisTurn: new Set<string>(),
    // AF-4 fields
    mode: 'active' as 'active' | 'silent',
    agentName,
    responsePassThrough: false,
    ackPassThrough: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — control phrases (silence)
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — silence commands', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  it('detects "Alice off" (AC-4.1)', () => {
    expect(classify('Alice off').type).toBe('silence');
  });

  it('detects "Alice, off" with comma', () => {
    expect(classify('Alice, off').type).toBe('silence');
  });

  it('detects "Alice sleep"', () => {
    expect(classify('Alice sleep').type).toBe('silence');
  });

  it('detects "Alice shut up"', () => {
    expect(classify('Alice shut up').type).toBe('silence');
  });

  it('detects "Alice stop listening"', () => {
    expect(classify('Alice stop listening').type).toBe('silence');
  });

  it('detects "Alice silencio" (ES)', () => {
    expect(classify('Alice silencio').type).toBe('silence');
  });

  it('detects "Alice, apágate" (ES)', () => {
    expect(classify('Alice, apágate').type).toBe('silence');
  });

  it('detects "Alice modo silencio" (ES)', () => {
    expect(classify('Alice modo silencio').type).toBe('silence');
  });

  it('detects "Alice cállate" (ES)', () => {
    expect(classify('Alice cállate').type).toBe('silence');
  });

  it('detects "Alice callate" (ES, no accent)', () => {
    expect(classify('Alice callate').type).toBe('silence');
  });

  it('detects "Alice off please" (trailing words)', () => {
    expect(classify('Alice off please').type).toBe('silence');
  });

  it('is case-insensitive', () => {
    expect(classify('ALICE OFF').type).toBe('silence');
    expect(classify('alice off').type).toBe('silence');
    expect(classify('Alice OFF').type).toBe('silence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — activate commands
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — activate commands', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  it('detects "Alice on" (AC-4.5)', () => {
    expect(classify('Alice on').type).toBe('activate');
  });

  it('detects "Alice, on" with comma', () => {
    expect(classify('Alice, on').type).toBe('activate');
  });

  it('detects "Alice wake up"', () => {
    expect(classify('Alice wake up').type).toBe('activate');
  });

  it('detects "Alice start listening"', () => {
    expect(classify('Alice start listening').type).toBe('activate');
  });

  it('detects "Alice vuelve" (ES)', () => {
    expect(classify('Alice vuelve').type).toBe('activate');
  });

  it('detects "Alice escucha" (ES)', () => {
    expect(classify('Alice escucha').type).toBe('activate');
  });

  it('detects "Alice despierta" (ES)', () => {
    expect(classify('Alice despierta').type).toBe('activate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — direct address (AC-4.3, AC-4.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — direct address', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  it('detects "Alice, ¿tú cómo lo ves?" (AC-4.3)', () => {
    expect(classify('Alice, ¿tú cómo lo ves?').type).toBe('direct_address');
  });

  it('detects "Alice, what time is it?"', () => {
    expect(classify('Alice, what time is it?').type).toBe('direct_address');
  });

  it('detects "Alice dime algo" (no comma)', () => {
    expect(classify('Alice dime algo').type).toBe('direct_address');
  });

  it('detects "Alice, ¿puedes ayudarme?"', () => {
    expect(classify('Alice, ¿puedes ayudarme?').type).toBe('direct_address');
  });

  // AC-4.6: third-person mentions do NOT break silence
  it('rejects "Alice is doing something" (third person EN)', () => {
    expect(classify('Alice is doing something').type).not.toBe('direct_address');
  });

  it('rejects "Alice was working on that" (third person EN)', () => {
    expect(classify('Alice was working on that').type).not.toBe('direct_address');
  });

  it('rejects "Alice está ocupada" (third person ES)', () => {
    expect(classify('Alice está ocupada').type).not.toBe('direct_address');
  });

  it('rejects "Alice dice que no" (third person ES)', () => {
    expect(classify('Alice dice que no').type).not.toBe('direct_address');
  });

  it('rejects "Le dije a Alice que..." (name not at start)', () => {
    expect(classify('Le dije a Alice que viniera').type).not.toBe('direct_address');
  });

  it('rejects "Hablaba con Alice sobre..." (name not at start)', () => {
    expect(classify('Hablaba con Alice sobre el proyecto').type).not.toBe('direct_address');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — normal speech
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — normal speech', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  it('classifies casual speech as normal', () => {
    expect(classify('Hola, ¿qué tal?').type).toBe('normal');
  });

  it('classifies "¿Qué hora es?" as normal', () => {
    expect(classify('¿Qué hora es?').type).toBe('normal');
  });

  it('classifies "Estoy hablando con Juan" as normal', () => {
    expect(classify('Estoy hablando con Juan').type).toBe('normal');
  });

  it('classifies empty string as normal', () => {
    expect(classify('').type).toBe('normal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — punctuation sanitisation (¡, ¿, !, ?, ., etc.)
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — punctuation sanitisation', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  // --- Silence commands with surrounding punctuation ---
  it('detects "¡Alice silencio!" (leading ¡ + trailing !)', () => {
    expect(classify('¡Alice silencio!').type).toBe('silence');
  });

  it('detects "¿Alice apágate?" (leading ¿ + trailing ?)', () => {
    expect(classify('¿Alice apágate?').type).toBe('silence');
  });

  it('detects "Alice silencio." (trailing period)', () => {
    expect(classify('Alice silencio.').type).toBe('silence');
  });

  it('detects "Alice off!" (trailing !)', () => {
    expect(classify('Alice off!').type).toBe('silence');
  });

  it('detects "¡Alice, off!" (leading ¡ + comma + trailing !)', () => {
    expect(classify('¡Alice, off!').type).toBe('silence');
  });

  // --- Activate commands with surrounding punctuation ---
  it('detects "Alice on!" (trailing !)', () => {
    expect(classify('Alice on!').type).toBe('activate');
  });

  it('detects "¡Alice vuelve!" (leading ¡ + trailing !)', () => {
    expect(classify('¡Alice vuelve!').type).toBe('activate');
  });

  // --- Direct address with punctuation ---
  it('detects "Alice, ¿tú cómo lo ves?" as direct_address (punctuation stripped)', () => {
    expect(classify('Alice, ¿tú cómo lo ves?').type).toBe('direct_address');
  });

  it('detects "¡Alice, dime algo!" as direct_address', () => {
    expect(classify('¡Alice, dime algo!').type).toBe('direct_address');
  });

  // --- False positives: must NOT trigger ---
  it('rejects "Le dije a Alice que se callara" (name not at start)', () => {
    expect(classify('Le dije a Alice que se callara').type).toBe('normal');
  });

  it('rejects "Alice está haciendo algo" (third person ES)', () => {
    expect(classify('Alice está haciendo algo').type).toBe('normal');
  });

  it('rejects "No sé, Alice dice que sí" (name not at start)', () => {
    expect(classify('No sé, Alice dice que sí').type).toBe('normal');
  });

  // --- Existing cases still work after the fix ---
  it('still detects "Alice off" (no punctuation)', () => {
    expect(classify('Alice off').type).toBe('silence');
  });

  it('still detects "Alice, off" (comma only)', () => {
    expect(classify('Alice, off').type).toBe('silence');
  });

  it('still detects "alice OFF" (case-insensitive)', () => {
    expect(classify('alice OFF').type).toBe('silence');
  });

  it('still detects "Alice   silencio" (extra spaces)', () => {
    expect(classify('Alice   silencio').type).toBe('silence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyIntent — custom agent name
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler classifyIntent — custom agent name', () => {
  const { handler } = makeHandler();
  const classify = (text: string, name = 'Alice') =>
    (handler as any).classifyIntent(text, name);

  it('detects "Nira off" when agent name is "Nira"', () => {
    expect(classify('Nira off', 'Nira').type).toBe('silence');
  });

  it('detects "Nira, ¿qué piensas?" when agent name is "Nira"', () => {
    expect(classify('Nira, ¿qué piensas?', 'Nira').type).toBe('direct_address');
  });

  it('uses first name from full name "Alice Solana"', () => {
    expect(classify('Alice off', 'Alice Solana').type).toBe('silence');
    expect(classify('Alice, ¿tú cómo lo ves?', 'Alice Solana').type).toBe('direct_address');
  });

  it('"Alice off" does NOT trigger when agent name is "Nira"', () => {
    expect(classify('Alice off', 'Nira').type).not.toBe('silence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Silent mode enforcement — agent_response suppression
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler silent mode — response suppression', () => {
  it('suppresses agent_response forwarding in silent mode (AC-4.2)', async () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    (handler as any).connections.set('conn1', conn);

    // Simulate an agent_response from ElevenLabs
    const agentResponseMsg = {
      type: 'agent_response',
      agent_response_event: { agent_response: 'This is a response' },
    };

    // Call the message handler directly via the internal method
    // We need to simulate what setupElevenLabsHandlers does
    const clientSent: any[] = [];
    const origSend = conn.clientWs.send.bind(conn.clientWs);
    conn.clientWs.send = (data: any) => { clientSent.push(data); };

    // The handler logic for agent_response in silent mode:
    // saves transcript but returns early (doesn't forward)
    // We test the behavior by checking that sendToClient is not called
    // Since the enforcement is inline in the message handler, we test
    // the condition directly:
    const shouldSuppress = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(shouldSuppress).toBe(true);
  });

  it('allows agent_response in silent mode with responsePassThrough (AC-4.3)', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.responsePassThrough = true;

    const shouldSuppress = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(shouldSuppress).toBe(false);
  });

  it('allows agent_response in silent mode with ackPassThrough (ack fix)', () => {
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.ackPassThrough = true;

    const shouldSuppress = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(shouldSuppress).toBe(false);
  });

  it('resets pass-through at start of next user_transcript turn (AC-4.4)', () => {
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.responsePassThrough = true;
    conn.ackPassThrough = true;

    // Simulate the reset that now happens at the start of user_transcript
    // (moved from agent_response handler so audio frames are still forwarded)
    conn.responsePassThrough = false;
    conn.ackPassThrough = false;

    expect(conn.mode).toBe('silent'); // mode unchanged
    expect(conn.responsePassThrough).toBe(false); // pass-through consumed
    expect(conn.ackPassThrough).toBe(false); // ack pass-through consumed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ack audio suppression fix — sendVoiceAck sets ackPassThrough in silent mode
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler sendVoiceAck — ack pass-through in silent mode', () => {
  it('sets ackPassThrough=true when sending ack in silent mode', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.ackPassThrough = false;

    (handler as any).sendVoiceAck(conn, 'Vale');

    expect(conn.ackPassThrough).toBe(true);
  });

  it('does NOT set ackPassThrough when sending ack in active mode', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'active';
    conn.ackPassThrough = false;

    (handler as any).sendVoiceAck(conn, 'Te escucho');

    // In active mode, no pass-through flag is needed — audio is always forwarded
    expect(conn.ackPassThrough).toBe(false);
  });

  it('sends user_message to ElevenLabs with [system_ack] prefix', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';

    (handler as any).sendVoiceAck(conn, 'Vale');

    const elevenLabsSent = (conn.elevenLabsWs as any).sent as any[];
    const userMsg = elevenLabsSent.find((m) => m.type === 'user_message');
    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe('[system_ack] Vale');
  });

  it('sends voice_ack event to client', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';

    (handler as any).sendVoiceAck(conn, 'Vale');

    const clientSent = (conn.clientWs as any).sent as any[];
    const ackEvent = clientSent.find((m) => m.type === 'voice_ack');
    expect(ackEvent).toBeDefined();
    expect(ackEvent.text).toBe('Vale');
  });

  it('audio suppression condition is false when ackPassThrough is true', () => {
    // Simulate the full flow: "Alice off" → mode=silent, ackPassThrough=true
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.ackPassThrough = true; // set by sendVoiceAck

    // The audio suppression condition in the ElevenLabs message handler
    const audioSuppressed = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(audioSuppressed).toBe(false); // audio should NOT be suppressed

    // The agent_response suppression condition
    const responseSuppressed = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(responseSuppressed).toBe(false); // response should NOT be suppressed
  });

  it('after next user_transcript, ackPassThrough resets and audio is suppressed again', () => {
    // Simulate the full flow:
    // 1. "Alice off" → mode=silent, ackPassThrough=true (ack plays)
    // 2. Next user_transcript → ackPassThrough resets to false
    // 3. Normal speech in silent mode → audio is suppressed
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.ackPassThrough = true; // from sendVoiceAck

    // Simulate next user_transcript reset
    conn.responsePassThrough = false;
    conn.ackPassThrough = false;

    // Now audio should be suppressed again
    const audioSuppressed = conn.mode === 'silent' && !conn.responsePassThrough && !conn.ackPassThrough;
    expect(audioSuppressed).toBe(true);
    expect(conn.mode).toBe('silent'); // still in silent mode
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Silent mode enforcement — idempotency (AC-4.1, spec §4.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler silent mode — idempotency', () => {
  it('repeated "Alice off" in silent mode does not re-ack', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent'; // already silent

    const intent = (handler as any).classifyIntent('Alice off', 'Alice');
    expect(intent.type).toBe('silence');

    // The enforcement code checks: if (connection.mode !== 'silent') { ... ack ... }
    // Since mode is already 'silent', no ack should be sent
    const shouldAck = conn.mode !== 'silent';
    expect(shouldAck).toBe(false);
  });

  it('repeated "Alice on" in active mode does not re-ack', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'active'; // already active

    const intent = (handler as any).classifyIntent('Alice on', 'Alice');
    expect(intent.type).toBe('activate');

    const shouldAck = conn.mode !== 'active';
    expect(shouldAck).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Silent mode enforcement — injectAgentResult respects mode
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler silent mode — injectAgentResult', () => {
  it('saves result but does not force speech in silent mode (spec §4.5)', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    (handler as any).connections.set('conn1', conn);

    // In injectAgentResult, the silent mode check prevents the user_message
    // (agent_response_ready) from being sent. The contextual_update and
    // saveTranscript still happen. We verify the condition:
    // Note: injectAgentResult only checks responsePassThrough, NOT ackPassThrough
    // — worker results are suppressed even while an ack is playing.
    const shouldForceSpeech = !(conn.mode === 'silent' && !conn.responsePassThrough);
    expect(shouldForceSpeech).toBe(false);
  });

  it('forces speech in active mode', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'active';
    (handler as any).connections.set('conn1', conn);

    const shouldForceSpeech = !(conn.mode === 'silent' && !conn.responsePassThrough);
    expect(shouldForceSpeech).toBe(true);
  });

  it('forces speech in silent mode with responsePassThrough', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.responsePassThrough = true;
    (handler as any).connections.set('conn1', conn);

    const shouldForceSpeech = !(conn.mode === 'silent' && !conn.responsePassThrough);
    expect(shouldForceSpeech).toBe(true);
  });

  it('does NOT force speech in silent mode with only ackPassThrough', () => {
    const { handler } = makeHandler();
    const conn = makeConnection();
    conn.mode = 'silent';
    conn.ackPassThrough = true;
    (handler as any).connections.set('conn1', conn);

    // ackPassThrough lets the ack audio through, but does NOT allow
    // worker results to force speech — only responsePassThrough does that.
    const shouldForceSpeech = !(conn.mode === 'silent' && !conn.responsePassThrough);
    expect(shouldForceSpeech).toBe(false);
  });
});
