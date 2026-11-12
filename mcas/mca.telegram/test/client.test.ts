import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// client.ts resolves APP_DATA_DIR at module load; point it at a temp dir
// BEFORE importing the module under test.
const tmp = mkdtempSync(join(tmpdir(), 'mca-telegram-test-'));
process.env.TELEGRAM_APP_DATA_DIR = tmp;

const {
  getApiCredentials,
  loadSavedSession,
  saveSession,
  clearSession,
  loadAuthState,
  saveAuthState,
  clearAuthState,
  peerToChatId,
  serializeUser,
  serializeChatEntity,
  serializeMessage,
  toToolError,
  runCatched,
} = await import('../src/lib/client');

afterEach(() => {
  clearSession();
  clearAuthState();
});

describe('getApiCredentials', () => {
  it('throws a helpful error when env vars are missing', () => {
    const prevId = process.env.TELEGRAM_API_ID;
    const prevHash = process.env.TELEGRAM_API_HASH;
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
    expect(() => getApiCredentials()).toThrow(/TELEGRAM_API_ID/);
    process.env.TELEGRAM_API_ID = prevId;
    process.env.TELEGRAM_API_HASH = prevHash;
  });

  it('parses apiId as a number when set', () => {
    process.env.TELEGRAM_API_ID = '123456';
    process.env.TELEGRAM_API_HASH = 'abc';
    expect(getApiCredentials()).toEqual({ apiId: 123456, apiHash: 'abc' });
  });
});

describe('session persistence', () => {
  it('returns null when no session saved', () => {
    expect(loadSavedSession()).toBeNull();
  });

  it('saves and reloads the session string with 0600 perms', async () => {
    saveSession('test-session-string');
    expect(loadSavedSession()).toBe('test-session-string');
    const stat = statSync(join(tmp, 'session.txt'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('clearSession removes the file', () => {
    saveSession('x');
    clearSession();
    expect(loadSavedSession()).toBeNull();
    expect(existsSync(join(tmp, 'session.txt'))).toBe(false);
  });
});

describe('auth state', () => {
  it('returns null when nothing saved', () => {
    expect(loadAuthState()).toBeNull();
  });

  it('round-trips a pending phoneCodeHash', () => {
    saveAuthState({ phoneCodeHash: 'hash123', phoneNumber: '34612345678', createdAt: Date.now() });
    expect(loadAuthState()).toEqual({ phoneCodeHash: 'hash123', phoneNumber: '34612345678', createdAt: expect.any(Number) });
  });

  it('treats states older than 15 minutes as expired', () => {
    saveAuthState({ phoneCodeHash: 'old', phoneNumber: '34612345678', createdAt: Date.now() - 16 * 60 * 1000 });
    expect(loadAuthState()).toBeNull();
  });
});

describe('peerToChatId', () => {
  it('maps PeerUser to the raw user id', () => {
    expect(peerToChatId({ className: 'PeerUser', userId: 5612345678n })).toBe('5612345678');
  });

  it('maps PeerChat to the raw chat id', () => {
    expect(peerToChatId({ className: 'PeerChat', chatId: 1234567n })).toBe('1234567');
  });

  it('maps PeerChannel with the -100 Bot-API prefix', () => {
    expect(peerToChatId({ className: 'PeerChannel', channelId: 1234567890n })).toBe('-1001234567890');
  });

  it('returns null for unknown peers', () => {
    expect(peerToChatId({ className: 'PeerSomething' })).toBeNull();
    expect(peerToChatId(null)).toBeNull();
  });
});

describe('serializeUser', () => {
  it('serializes a full user', () => {
    const out = serializeUser({ id: 42n, firstName: 'Ada', lastName: 'Lovelace', username: 'ada', phone: '34600111222', bot: false, premium: true, verified: true, photo: { className: 'UserProfilePhoto' } });
    expect(out).toEqual({
      id: '42', firstName: 'Ada', lastName: 'Lovelace', username: 'ada', phone: '34600111222',
      isBot: false, isPremium: true, isVerified: true, hasPhoto: true,
    });
  });

  it('handles null/empty users', () => {
    expect(serializeUser(null)).toEqual({});
    expect(serializeUser({}).id).toBeNull();
  });
});

describe('serializeChatEntity', () => {
  it('flags channels and uses the -100 chatId convention', () => {
    const out = serializeChatEntity({ className: 'Channel', id: 1234567890n, title: 'Teros News', username: 'terosnews', broadcast: true, participantsCount: 1000 });
    expect(out.type).toBe('channel');
    expect(out.chatId).toBe('-1001234567890');
    expect(out.membersCount).toBe(1000);
  });

  it('flags megagroups as supergroup', () => {
    const out = serializeChatEntity({ className: 'Channel', id: 42n, title: 'Devs', megagroup: true });
    expect(out.type).toBe('supergroup');
  });

  it('treats users as private chats', () => {
    const out = serializeChatEntity({ className: 'User', id: 42n, firstName: 'Ada', username: 'ada' });
    expect(out.type).toBe('user');
    expect(out.chatId).toBe('42');
    expect(out.title).toBeNull();
    expect(out.firstName).toBe('Ada');
  });
});

describe('serializeMessage', () => {
  it('serializes a plain text message', () => {
    const out = serializeMessage({
      id: 10, peerId: { className: 'PeerUser', userId: 42n }, date: 1728800000,
      message: 'hello', fromId: { className: 'PeerUser', userId: 99n }, out: true,
      replyTo: { replyToMsgId: 7 },
    });
    expect(out.id).toBe(10);
    expect(out.text).toBe('hello');
    expect(out.chatId).toBe('42');
    expect(out.fromId).toBe('99');
    expect(out.fromMe).toBe(true);
    expect(out.replyToMsgId).toBe(7);
    expect(out.hasMedia).toBe(false);
    expect(out.mediaType).toBeNull();
    expect(out.date).toBe(new Date(1728800000 * 1000).toISOString());
  });

  it('detects media and ignores MessageMediaEmpty', () => {
    expect(serializeMessage({ id: 1, media: { className: 'MessageMediaPhoto' } }).mediaType).toBe('MessageMediaPhoto');
    expect(serializeMessage({ id: 1, media: { className: 'MessageMediaEmpty' } }).mediaType).toBeNull();
    expect(serializeMessage({ id: 1 }).hasMedia).toBe(false);
  });
});

describe('toToolError / runCatched', () => {
  it('converts generic errors to { success:false, error }', async () => {
    const out = await runCatched(async () => { throw new Error('boom'); });
    expect(out).toEqual({ success: false, error: 'boom' });
  });

  it('passes through the handler result on success', async () => {
    const out = await runCatched(async () => ({ success: true, value: 7 }));
    expect(out).toEqual({ success: true, value: 7 });
  });

  it('prefers Telegram errorMessage over message', async () => {
    const out = toToolError({ errorMessage: 'CHAT_ADMIN_REQUIRED' });
    expect(out).toEqual({ success: false, error: 'CHAT_ADMIN_REQUIRED' });
  });
});
