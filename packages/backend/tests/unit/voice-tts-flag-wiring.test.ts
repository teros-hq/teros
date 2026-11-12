/**
 * VoiceLoop × voice.tts flag — F5d wiring tests.
 *
 * The flag decides WHICH provider a connection gets (voice-loop.ts):
 *
 *  - flag off / default ('sentences') / no FeatureFlagService → the
 *    injectable ttsFactory is used — the pre-F5d path, byte for byte.
 *  - flag 'stream' → the ElevenLabsStreamTtsProvider.
 *  - flag resolution throws → 'sentences' (a broken flag must never break
 *    the voice session — same contract as voice.llm).
 *
 * Strategy: same harness as voice-loop.test.ts (FakeWs, stub deps,
 * connections map via (loop as any)), with a stub FeatureFlagService whose
 * resolve() the tests control.
 */

import { describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';
import { ElevenLabsStreamTtsProvider } from '../../src/services/tts/ElevenLabsStreamTtsProvider';
import { ElevenLabsFlashTtsProvider } from '../../src/services/tts/ElevenLabsFlashTtsProvider';
import type { IStreamingTranscriptionProvider, StreamingTranscriptionCallbacks } from '../../src/services/transcription/IStreamingTranscriptionProvider';
import type { ITtsProvider } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Stubs (same shapes as voice-loop.test.ts)
// ---------------------------------------------------------------------------

class FakeWs {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  handlers: Record<string, ((data?: any) => void)[]> = {};
  send = (data: string) => { this.sent.push(data); };
  close = () => { this.closed = true; };
  on = (event: string, handler: (data?: any) => void) => {
    (this.handlers[event] ??= []).push(handler);
  };
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

class MockStt implements IStreamingTranscriptionProvider {
  callbacks: StreamingTranscriptionCallbacks | null = null;
  async connect(callbacks: StreamingTranscriptionCallbacks) { this.callbacks = callbacks; }
  sendAudio() {}
  close() {}
}

class MarkerTts implements ITtsProvider {
  constructor(public marker: string) {}
  speak() {}
  feed() {}
  endOfText() {}
  cancel() {}
  isSpeaking() { return false; }
}

/** Stub FeatureFlagService — resolve() returns the configured value. */
class StubFlagService {
  constructor(public value: any) {}
  async resolve(_key: string): Promise<any> { return this.value; }
}

/** Stub FeatureFlagService whose resolve() throws — but only for voice.tts. */
class ThrowingFlagService {
  async resolve(key: string): Promise<any> {
    if (key === 'voice.tts') throw new Error('flag backend down');
    return 'sentences';
  }
}

function makeDb(channels: Record<string, any>) {
  const voiceSessionUpdates: any[] = [];
  const collection = (name: string) => ({
    findOne: async (filter: any) => {
      if (name === 'channels') return channels[filter.channelId] ?? null;
      if (name === 'agents') return { agentId: filter.agentId, name: 'Agent', workspaceId: 'ws1' };
      if (name === 'voice_sessions') return null;
      return null;
    },
    updateOne: async (filter: any, update: any) => {
      if (name === 'voice_sessions') voiceSessionUpdates.push({ filter, update });
    },
  });
  return {
    collection: (name: string) => collection(name),
    voiceSessionUpdates,
  } as any;
}

function makeLoop(opts: {
  channels?: Record<string, any>;
  flagService?: any;
  tts?: ITtsProvider;
} = {}) {
  const channels = opts.channels ?? {
    ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  };
  const db = makeDb(channels);
  const channelManager = {
    getChannel: async (id: string) => channels[id] ?? null,
    createMessageId: () => `msg_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async () => {},
  };
  const pubSubService = { addListener() {}, removeListener() {}, broadcastToTopic() {} };
  const authService = { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) };
  const workspaceService = { canAccess: async () => true };
  const messageHandler = { processAgentResponse: async () => {} };
  const stt = new MockStt();
  const tts = opts.tts ?? new MarkerTts('factory-tts');

  const loop = new VoiceLoop(
    db,
    channelManager as any,
    {} as any,
    messageHandler as any,
    workspaceService as any,
    opts.flagService ?? null,
    authService as any,
    { sttFactory: () => stt, ttsFactory: () => tts },
  );
  loop.setPubSubService(pubSubService as any);
  return { loop, tts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceLoop × voice.tts flag (F5d wiring)', () => {
  it('flag off (default) — the injected ttsFactory is used, ttsMode=sentences', async () => {
    const { loop, tts } = makeLoop({ flagService: new StubFlagService('sentences') });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBe(tts); // the factory's provider — zero change
    expect(connection.ttsMode).toBe('sentences');
  });

  it('no FeatureFlagService — the injected ttsFactory is used (zero change)', async () => {
    const { loop, tts } = makeLoop();
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBe(tts);
    expect(connection.ttsMode).toBe('sentences');
  });

  it("flag 'stream' — the connection gets the ElevenLabsStreamTtsProvider", async () => {
    const { loop } = makeLoop({ flagService: new StubFlagService('stream') });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBeInstanceOf(ElevenLabsStreamTtsProvider);
    expect(connection.ttsMode).toBe('stream');
  });

  it('flag resolution throws — degrades to sentences (session never breaks)', async () => {
    const { loop, tts } = makeLoop({ flagService: new ThrowingFlagService() });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBe(tts); // the factory's provider — degraded
    expect(connection.ttsMode).toBe('sentences');
  });

  it('an unknown flag value degrades to sentences (no partial application)', async () => {
    const { loop, tts } = makeLoop({ flagService: new StubFlagService('banana') });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBe(tts);
    expect(connection.ttsMode).toBe('sentences');
  });

  it('flag off — the default factory still builds the sentence provider in prod wiring', async () => {
    // The default (non-injected) ttsFactory path: 'sentences' must produce
    // the sentence provider exactly as before F5d. Needs a stub
    // secretsManager (the default factory resolves the elevenlabs secret).
    const db = makeDb({
      ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1' },
    });
    const channelManager = {
      getChannel: async (id: string) => (id === 'ch_conv' ? { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1' } : null),
      createMessageId: () => 'm1',
      saveMessage: async () => {},
    };
    const secretsManager = {
      system: () => ({ apiKey: 'sk-test' }),
    };
    const loop = new VoiceLoop(
      db,
      channelManager as any,
      secretsManager as any,
      { processAgentResponse: async () => {} } as any,
      { canAccess: async () => true } as any,
      new StubFlagService('sentences'),
      { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) } as any,
      // No ttsFactory injected — the DEFAULT prod factory runs.
      { sttFactory: () => new MockStt() as any },
    );
    loop.setPubSubService({ addListener() {}, removeListener() {}, broadcastToTopic() {} } as any);
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (loop as any).connections.values().next().value;
    expect(connection.tts).toBeInstanceOf(ElevenLabsFlashTtsProvider);
    expect(connection.ttsMode).toBe('sentences');
  });
});
