/**
 * VoiceHandler — AF-5: voice → text context unification via session store.
 *
 * Tests that persistTranscriptLine writes voice transcripts to BOTH:
 * - channel_messages (display store, via channelManager.saveMessage)
 * - session_messages (LLM context store, via sessionStore.writeMessage + writePart)
 *
 * Without the session store dual-write, the text agent cannot see what was said
 * during voice mode because it loads history from session_messages, not
 * channel_messages.
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
  on() { /* not needed */ }
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

  // Track all calls to channelManager.saveMessage
  const savedChannelMessages: any[] = [];
  const channelManager = {
    createMessageId: () => `msg_${Math.random().toString(36).slice(2)}`,
    saveMessage: async (msg: any) => { savedChannelMessages.push(msg); },
    getChannel: async () => null,
  };

  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic() {},
  };

  // Track all calls to sessionStore.writeMessage and writePart
  const writtenSessionMessages: any[] = [];
  const writtenSessionParts: any[] = [];
  const sessionStore = {
    async writeMessage(msg: any) { writtenSessionMessages.push(msg); },
    async writePart(part: any) { writtenSessionParts.push(part); },
    async getMessagesForLLM() { return { messages: [] }; },
    async getMessagesWithParts() { return []; },
    async getSession() { return undefined; },
    async writeSession() {},
    async deleteSession() {},
    async listSessions() { return []; },
    async touchSession() {},
    async updateUserMessageQueueState() {},
    async listPendingQueueMessages() { return []; },
    async listParts() { return []; },
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
  handler.setSessionStore(sessionStore as any);

  return { handler, savedChannelMessages, writtenSessionMessages, writtenSessionParts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AF-5: Voice transcript → session store (voice→text context unification)', () => {
  it('persistTranscriptLine writes to both channel_messages and session_messages when broadcast=true', async () => {
    const { handler, savedChannelMessages, writtenSessionMessages, writtenSessionParts } = makeHandler();

    // Access the private method via any cast
    const chatChannelId = 'ch_test_chat_123';
    const userText = 'Hola, ¿qué tal?';
    const voiceChannelId = 'ch_voice_456';

    // Call persistTranscriptLine with broadcast=true (simulating write to chat channel)
    await (handler as any).persistTranscriptLine(
      chatChannelId,
      userText,
      true, // isUser
      true, // broadcast=true → should dual-write to session store
    );

    // Verify channel_messages got the message
    expect(savedChannelMessages.length).toBe(1);
    expect(savedChannelMessages[0].channelId).toBe(chatChannelId);
    expect(savedChannelMessages[0].role).toBe('user');
    expect(savedChannelMessages[0].source).toBe('voice');
    expect(savedChannelMessages[0].content.text).toBe(userText);

    // Verify session_messages also got the message (this is the AF-5 fix)
    expect(writtenSessionMessages.length).toBe(1);
    expect(writtenSessionMessages[0].sessionID).toBe(chatChannelId);
    expect(writtenSessionMessages[0].role).toBe('user');
    expect(writtenSessionMessages[0].id).toMatch(/^msg_\d+_/);

    // Verify a TextPart was written with the actual content
    expect(writtenSessionParts.length).toBe(1);
    expect(writtenSessionParts[0].sessionID).toBe(chatChannelId);
    expect(writtenSessionParts[0].type).toBe('text');
    expect(writtenSessionParts[0].text).toBe(userText);
    expect(writtenSessionParts[0].metadata?.source).toBe('voice');
    expect(writtenSessionParts[0].synthetic).toBe(true);
  });

  it('persistTranscriptLine writes assistant transcripts to session store with assistant role', async () => {
    const { handler, writtenSessionMessages, writtenSessionParts } = makeHandler();

    const chatChannelId = 'ch_test_chat_789';
    const agentText = '¡Hola! Todo bien, ¿y tú?';

    await (handler as any).persistTranscriptLine(
      chatChannelId,
      agentText,
      false, // isUser=false → assistant
      true,  // broadcast=true
    );

    // Verify session_messages got an assistant message
    expect(writtenSessionMessages.length).toBe(1);
    expect(writtenSessionMessages[0].sessionID).toBe(chatChannelId);
    expect(writtenSessionMessages[0].role).toBe('assistant');

    // Verify the TextPart has the agent's text
    expect(writtenSessionParts.length).toBe(1);
    expect(writtenSessionParts[0].text).toBe(agentText);
  });

  it('persistTranscriptLine does NOT write to session store when broadcast=false (voice-only channel)', async () => {
    const { handler, writtenSessionMessages } = makeHandler();

    const voiceChannelId = 'ch_voice_only';

    // broadcast=false → this is a voice-only internal message, should NOT go to session store
    await (handler as any).persistTranscriptLine(
      voiceChannelId,
      '🛠️ some internal system line',
      false, // isUser
      false, // broadcast=false → voice-only, no session store write
    );

    // Session store should NOT have been written to
    expect(writtenSessionMessages.length).toBe(0);
  });

  it('persistTranscriptLine does NOT crash when sessionStore is not set', async () => {
    const { handler, savedChannelMessages } = makeHandler();

    // Remove the session store by creating a handler without it
    const subscriptionService = {
      async createChannelSubscriptionsBatch() { return []; },
      async deleteChannelSubscription() { return true; },
    };
    const db = {
      collection: () => ({
        findOne: async () => null,
        find: () => ({ toArray: async () => [] }),
        updateOne: async () => ({ modifiedCount: 1 }),
      }),
    };
    const channelManager = {
      createMessageId: () => `msg_test`,
      saveMessage: async () => {},
      getChannel: async () => null,
    };
    const pubSubService = {
      addListener() {},
      removeListener() {},
      broadcastToTopic() {},
    };
    const handlerNoSession = new VoiceHandler(
      db as any,
      {} as any,
      channelManager as any,
      {} as any,
      {} as any,
      subscriptionService as any,
      { validateSession: async () => ({ success: false }) } as any,
    );
    handlerNoSession.setPubSubService(pubSubService as any);
    // Note: NOT calling setSessionStore — simulating old behavior

    // Should not throw
    await (handlerNoSession as any).persistTranscriptLine(
      'ch_test',
      'test text',
      true,
      true, // broadcast=true, but no sessionStore → should silently skip
    );

    // If we get here without throwing, the test passes
    expect(true).toBe(true);
  });

  it('multiple voice transcripts create multiple session store entries (conversation history)', async () => {
    const { handler, writtenSessionMessages, writtenSessionParts } = makeHandler();

    const chatChannelId = 'ch_conversation_test';

    // Simulate a back-and-forth voice conversation
    const exchanges = [
      { text: '¿Qué hora es?', isUser: true },
      { text: 'Son las tres de la tarde.', isUser: false },
      { text: 'Gracias.', isUser: true },
      { text: 'De nada, ¿algo más?', isUser: false },
    ];

    for (const exchange of exchanges) {
      await (handler as any).persistTranscriptLine(
        chatChannelId,
        exchange.text,
        exchange.isUser,
        true, // broadcast=true
      );
    }

    // All 4 exchanges should be in session_messages
    expect(writtenSessionMessages.length).toBe(4);
    expect(writtenSessionParts.length).toBe(4);

    // Verify the conversation order and roles
    expect(writtenSessionMessages[0].role).toBe('user');
    expect(writtenSessionParts[0].text).toBe('¿Qué hora es?');

    expect(writtenSessionMessages[1].role).toBe('assistant');
    expect(writtenSessionParts[1].text).toBe('Son las tres de la tarde.');

    expect(writtenSessionMessages[2].role).toBe('user');
    expect(writtenSessionParts[2].text).toBe('Gracias.');

    expect(writtenSessionMessages[3].role).toBe('assistant');
    expect(writtenSessionParts[3].text).toBe('De nada, ¿algo más?');

    // All should be in the same channel/session
    for (const msg of writtenSessionMessages) {
      expect(msg.sessionID).toBe(chatChannelId);
    }
  });
});
