import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { buildMessageEventPayload, messageTopic, TELEGRAM_EVENT_TOPICS } from '../src/lib/events';

/**
 * The event catalog (manifest.json events[].payload) is what agents and the
 * Automate window use to write filters and templates. These tests pin the
 * emitted payload to that catalog so the two can never drift apart again.
 */

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  events: Array<{ topic: string; payload: Record<string, string> }>;
};
const declared = (topic: string) => Object.keys(manifest.events.find((e) => e.topic === topic)!.payload);

const user = { className: 'User', id: 42n, firstName: 'Ada', lastName: 'Lovelace', username: 'ada' };
const group = { className: 'Channel', id: 777n, title: 'Ops', username: 'ops_room', megagroup: true };

const resolver = async (peer: unknown) => {
  const p = peer as { className?: string };
  if (p?.className === 'PeerUser') return user;
  if (p?.className === 'PeerChannel') return group;
  return null;
};

const incoming = {
  id: 1001,
  peerId: { className: 'PeerChannel', channelId: 777n },
  fromId: { className: 'PeerUser', userId: 42n },
  date: 1_760_000_000,
  message: 'hola @me',
  out: false,
  mentioned: true,
  replyTo: { replyToMsgId: 900 },
  media: null,
};

describe('message event payload matches the manifest catalog', () => {
  it('received: every declared field is present', async () => {
    const payload = await buildMessageEventPayload(incoming, resolver);
    for (const key of declared('telegram.message.received')) expect(payload).toHaveProperty(key);
    expect(payload.fromName).toBe('Ada Lovelace');
    expect(payload.fromUsername).toBe('ada');
    expect(payload.chatTitle).toBe('Ops');
    expect(payload.chatType).toBe('supergroup');
    expect(payload.chatUsername).toBe('ops_room');
    expect(payload.messageId).toBe(1001);
    expect(payload.isOutgoing).toBe(false);
    expect(payload.mentioned).toBe(true);
    expect(payload.replyToMsgId).toBe(900);
    expect(payload.text).toBe('hola @me');
  });

  it('sent: same catalog, isOutgoing true', async () => {
    const payload = await buildMessageEventPayload({ ...incoming, out: true, fromId: null }, resolver);
    for (const key of declared('telegram.message.sent')) expect(payload).toHaveProperty(key);
    expect(payload.isOutgoing).toBe(true);
  });

  it('edited: declared fields minus editedAt (stamped by the handler)', async () => {
    const payload = await buildMessageEventPayload(incoming, resolver);
    for (const key of declared('telegram.message.edited').filter((k) => k !== 'editedAt')) expect(payload).toHaveProperty(key);
  });

  it('private chat without fromId: the peer is the sender', async () => {
    const payload = await buildMessageEventPayload(
      { ...incoming, fromId: undefined, peerId: { className: 'PeerUser', userId: 42n } },
      resolver,
    );
    expect(payload.chatType).toBe('user');
    expect(payload.fromName).toBe('Ada Lovelace');
    expect(payload.fromId).toBe(payload.chatId);
  });

  it('a failed entity lookup degrades to null names, never throws', async () => {
    const payload = await buildMessageEventPayload(incoming, async () => {
      throw new Error('FLOOD_WAIT');
    });
    expect(payload.fromName).toBeNull();
    expect(payload.chatTitle).toBeNull();
    expect(payload.fromId).toBe('42');
  });
});

describe('topic routing', () => {
  it('incoming → received, own sends → sent', () => {
    expect(messageTopic({ out: false })).toBe('telegram.message.received');
    expect(messageTopic({ out: true })).toBe('telegram.message.sent');
  });

  it('every emitted topic is declared in the manifest', () => {
    const declaredTopics = manifest.events.map((e) => e.topic);
    for (const t of TELEGRAM_EVENT_TOPICS) expect(declaredTopics).toContain(t);
    expect(declaredTopics).toHaveLength(TELEGRAM_EVENT_TOPICS.length);
  });
});
