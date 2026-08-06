/**
 * Tests for `_helpers.ts` — id validators + shape extractors.
 *
 * Locks the curated shape contract: every Slack resource is collapsed to
 * a flat camelCase object the renderer + LLM consume. Drift here breaks
 * the renderer tile/avatar/stat displays silently.
 */

import { describe, expect, it } from 'bun:test';
import {
  cleanOptionalString,
  extractChannel,
  extractFile,
  extractMessage,
  extractPresence,
  extractTeam,
  extractUser,
  isChannelId,
  isFileId,
  isMessageTs,
  isUserId,
  tsToIso,
  validateChannelId,
  validateMessageTs,
  validateUserId,
} from '../../src/tools/_helpers';

describe('id validators', () => {
  it('isChannelId accepts C/D/G/M-prefixed ids', () => {
    expect(isChannelId('C01ABCDEFGH')).toBe(true);
    expect(isChannelId('GTABCDEFGHI')).toBe(true);
    expect(isChannelId('D03Z9X8C7V6')).toBe(true);
    expect(isChannelId('M01ABCDEFGH')).toBe(true);
  });

  it('isChannelId rejects malformed', () => {
    expect(isChannelId('U01ABCDEFGH')).toBe(false);
    expect(isChannelId('c01abcdefgh')).toBe(false);
    expect(isChannelId('')).toBe(false);
    expect(isChannelId(null)).toBe(false);
  });

  it('isUserId accepts U/W-prefixed ids', () => {
    expect(isUserId('U01ABCDEFGH')).toBe(true);
    expect(isUserId('W12345678')).toBe(true);
  });

  it('isFileId requires F prefix', () => {
    expect(isFileId('F01ABCDEFGH')).toBe(true);
    expect(isFileId('f01ABCDEFGH')).toBe(false);
  });

  it('isMessageTs requires 10.6 format', () => {
    expect(isMessageTs('1234567890.123456')).toBe(true);
    expect(isMessageTs('1234567890.12345')).toBe(false);
    expect(isMessageTs('1234567890')).toBe(false);
  });

  it('validators throw with descriptive label', () => {
    expect(() => validateChannelId('Uxxx', 'channel')).toThrow(/channel.*Slack channel id/);
    expect(() => validateUserId('Cxxx', 'userId')).toThrow(/userId.*Slack user id/);
    expect(() => validateMessageTs('not-ts', 'ts')).toThrow(/ts.*Slack timestamp/);
  });
});

describe('cleanOptionalString', () => {
  it('returns the trimmed string when non-empty', () => {
    expect(cleanOptionalString('hello')).toBe('hello');
    expect(cleanOptionalString('  text  ')).toBe('text');
  });

  it('returns undefined for empty/whitespace/non-string', () => {
    expect(cleanOptionalString('')).toBeUndefined();
    expect(cleanOptionalString('   ')).toBeUndefined();
    expect(cleanOptionalString(undefined)).toBeUndefined();
    expect(cleanOptionalString(null)).toBeUndefined();
    expect(cleanOptionalString(0)).toBeUndefined();
  });
});

describe('tsToIso', () => {
  it('converts unix-seconds number to ISO', () => {
    expect(tsToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(tsToIso(1700000000)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('converts Slack ts string to ISO', () => {
    expect(tsToIso('1700000000.000000')).toBe('2023-11-14T22:13:20.000Z');
  });

  it('returns null for unparseable', () => {
    expect(tsToIso(undefined)).toBeNull();
    expect(tsToIso(null)).toBeNull();
    expect(tsToIso('not a ts')).toBeNull();
  });
});

describe('extractChannel', () => {
  it('flattens raw Slack channel to curated camelCase', () => {
    const raw = {
      id: 'C01',
      name: 'general',
      is_private: false,
      is_archived: false,
      is_member: true,
      num_members: 42,
      topic: { value: 'team chat', creator: 'U01' },
      purpose: { value: 'broadcast' },
      created: 1700000000,
      creator: 'U02',
      is_general: true,
    };
    const curated = extractChannel(raw);
    expect(curated.id).toBe('C01');
    expect(curated.name).toBe('general');
    expect(curated.isPrivate).toBe(false);
    expect(curated.isArchived).toBe(false);
    expect(curated.numMembers).toBe(42);
    expect(curated.topic).toBe('team chat');
    expect(curated.purpose).toBe('broadcast');
    expect(curated.created).toBe('2023-11-14T22:13:20.000Z');
    expect(curated.creator).toBe('U02');
    expect(curated.isGeneral).toBe(true);
  });

  it('handles missing fields with safe defaults', () => {
    const curated = extractChannel({});
    expect(curated.id).toBe('');
    expect(curated.name).toBe('');
    expect(curated.isPrivate).toBe(false);
    expect(curated.numMembers).toBeNull();
    expect(curated.topic).toBe('');
  });
});

describe('extractMessage', () => {
  it('flattens raw Slack message + reactions', () => {
    const raw = {
      ts: '1700000000.000000',
      user: 'U01',
      text: 'hello',
      thread_ts: '1699000000.000000',
      reply_count: 3,
      reactions: [
        { name: 'thumbsup', count: 2, users: ['U01', 'U02'] },
        { name: 'fire', count: 1, users: ['U03'] },
      ],
    };
    const curated = extractMessage(raw, { channel: 'C01', userName: 'alice' });
    expect(curated.ts).toBe('1700000000.000000');
    expect(curated.channel).toBe('C01');
    expect(curated.user).toBe('U01');
    expect(curated.userName).toBe('alice');
    expect(curated.text).toBe('hello');
    expect(curated.threadTs).toBe('1699000000.000000');
    expect(curated.replyCount).toBe(3);
    expect(curated.reactions).toHaveLength(2);
    expect(curated.reactions[0]).toEqual({
      name: 'thumbsup',
      count: 2,
      users: ['U01', 'U02'],
    });
    expect(curated.createdAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('falls back to bot_id when user is missing', () => {
    const curated = extractMessage({ ts: '1700000000.000000', bot_id: 'B01', text: 'beep' });
    expect(curated.user).toBe('B01');
  });
});

describe('extractUser', () => {
  it('flattens raw Slack user with profile', () => {
    const raw = {
      id: 'U01',
      name: 'alice',
      deleted: false,
      is_admin: false,
      is_bot: false,
      tz: 'America/New_York',
      profile: {
        real_name: 'Alice Smith',
        display_name: 'alice',
        email: 'alice@example.com',
        image_192: 'https://avatars/alice.png',
        title: 'Engineer',
        status_text: 'on vacation',
        status_emoji: ':palm_tree:',
      },
    };
    const curated = extractUser(raw);
    expect(curated.id).toBe('U01');
    expect(curated.name).toBe('alice');
    expect(curated.realName).toBe('Alice Smith');
    expect(curated.displayName).toBe('alice');
    expect(curated.email).toBe('alice@example.com');
    expect(curated.imageUrl).toBe('https://avatars/alice.png');
    expect(curated.title).toBe('Engineer');
    expect(curated.statusText).toBe('on vacation');
    expect(curated.statusEmoji).toBe(':palm_tree:');
    expect(curated.tz).toBe('America/New_York');
  });

  it('picks the largest available image', () => {
    const curated = extractUser({
      id: 'U01',
      profile: { image_72: 'small.png' },
    });
    expect(curated.imageUrl).toBe('small.png');
  });
});

describe('extractFile', () => {
  it('flattens raw Slack file', () => {
    const raw = {
      id: 'F01',
      name: 'report.pdf',
      title: 'Q4 Report',
      mimetype: 'application/pdf',
      filetype: 'pdf',
      pretty_type: 'PDF',
      size: 102400,
      user: 'U01',
      url_private: 'https://files.slack.com/private',
      permalink: 'https://workspace.slack.com/files/U01/F01',
      thumb_360: 'https://thumb360.png',
      channels: ['C01'],
      is_public: false,
      created: 1700000000,
    };
    const curated = extractFile(raw, 'alice');
    expect(curated.id).toBe('F01');
    expect(curated.title).toBe('Q4 Report');
    expect(curated.mimetype).toBe('application/pdf');
    expect(curated.prettyType).toBe('PDF');
    expect(curated.size).toBe(102400);
    expect(curated.userName).toBe('alice');
    expect(curated.thumbUrl).toBe('https://thumb360.png');
    expect(curated.channels).toEqual(['C01']);
  });
});

describe('extractTeam', () => {
  it('picks the largest available icon', () => {
    const curated = extractTeam({
      id: 'T01',
      name: 'Acme',
      domain: 'acme',
      email_domain: 'acme.com',
      icon: { image_44: '44.png', image_132: '132.png', image_230: '230.png' },
    });
    expect(curated.iconUrl).toBe('230.png');
    expect(curated.domain).toBe('acme');
  });
});

describe('extractPresence', () => {
  it('flattens raw presence into the curated shape', () => {
    const curated = extractPresence('U01', {
      presence: 'active',
      online: true,
      auto_away: false,
      manual_away: false,
      connection_count: 1,
      last_activity: 1700000000,
    });
    expect(curated.user).toBe('U01');
    expect(curated.presence).toBe('active');
    expect(curated.online).toBe(true);
    expect(curated.lastActivity).toBe('2023-11-14T22:13:20.000Z');
  });
});
