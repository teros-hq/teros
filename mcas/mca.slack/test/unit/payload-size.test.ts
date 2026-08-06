/**
 * Context-size regression tests for `mca.slack`.
 *
 * Slack list endpoints can return very large payloads (`conversations.list`
 * easily ships 100KB+ raw). The curated shape via `extractX` keeps the
 * agent context lean. These tests freeze the budget per response so a
 * future field addition that bloats the shape gets caught in CI.
 *
 * Budgets calibrated against synthetic Slack data (mock fixtures below):
 *   - list-channels 100 ch  → ~38 KB curated → budget 48 KB
 *   - list-messages 100 msg → ~38 KB curated (incl. reactions) → budget 50 KB
 *   - list-users 100 users  → ~38 KB curated → budget 48 KB
 *   - search-messages 50 hits → ~12 KB curated → budget 20 KB
 *
 * Each budget has +25% headroom for organic growth. Going over means the
 * shape gained a non-essential field — review before bumping.
 */

import { describe, expect, it } from 'bun:test';
import {
  extractChannel,
  extractFile,
  extractMessage,
  extractSearchFileHit,
  extractSearchMessageHit,
  extractUser,
} from '../../src/tools/_helpers';

/** Build a synthetic channel that mirrors the verbose Slack shape. */
function mockSlackChannel(i: number) {
  return {
    id: `C${String(i).padStart(10, '0')}`,
    name: `channel-${i}`,
    is_private: i % 3 === 0,
    is_archived: false,
    is_member: true,
    num_members: 25 + (i % 100),
    topic: { value: `Topic for channel ${i} — internal discussions`, creator: `U000${i}`, last_set: 1715000000 + i },
    purpose: { value: `Purpose ${i}`, creator: `U000${i}`, last_set: 1715000000 + i },
    created: 1700000000 + i,
    creator: `U000${i}`,
    is_general: i === 0,
    is_shared: false,
    is_org_shared: false,
    is_ext_shared: false,
    unlinked: 0,
    name_normalized: `channel-${i}`,
    previous_names: [],
  };
}

function mockSlackMessage(i: number, channel: string) {
  return {
    ts: `${1715000000 + i}.${String(i).padStart(6, '0')}`,
    user: `U${String(i % 50).padStart(10, '0')}`,
    text: `Message ${i} with some realistic content that an agent might post — typically a paragraph or two.`,
    subtype: null,
    thread_ts: i % 7 === 0 ? `${1714999999 + i}.000000` : undefined,
    reply_count: i % 7 === 0 ? 3 : 0,
    reactions:
      i % 5 === 0
        ? [
            { name: 'thumbsup', count: 4, users: [`U001`, `U002`, `U003`, `U004`] },
            { name: 'eyes', count: 2, users: [`U005`, `U006`] },
          ]
        : [],
    blocks: undefined,
  };
}

function mockSlackUser(i: number) {
  return {
    id: `U${String(i).padStart(10, '0')}`,
    name: `user${i}`,
    real_name: `User Number ${i}`,
    profile: {
      email: `user${i}@example.com`,
      display_name: `user-${i}`,
      image_192: `https://avatars.slack.com/user-${i}-192.jpg`,
      image_72: `https://avatars.slack.com/user-${i}-72.jpg`,
      title: `Engineer at team-${i % 5}`,
    },
    is_bot: i % 30 === 0,
    is_admin: i === 0,
    is_owner: i === 0,
    deleted: false,
    tz: 'Europe/Madrid',
  };
}

function mockSlackFile(i: number) {
  return {
    id: `F${String(i).padStart(10, '0')}`,
    name: `report-${i}.pdf`,
    title: `Quarterly Report ${i}`,
    mimetype: 'application/pdf',
    filetype: 'pdf',
    pretty_type: 'PDF',
    size: 1024 * (100 + i),
    user: `U${String(i % 50).padStart(10, '0')}`,
    url_private: `https://files.slack.com/F${i}/report.pdf`,
    permalink: `https://teros.slack.com/files/U${i % 50}/F${i}/report-${i}.pdf`,
    thumb_360: `https://files.slack.com/F${i}/thumb_360.png`,
    channels: [`C${String(i % 10).padStart(10, '0')}`],
    is_public: false,
    created: 1715000000 + i,
  };
}

function mockSearchMessageHit(i: number) {
  return {
    iid: `match-${i}`,
    ts: `${1715000000 + i}.${String(i).padStart(6, '0')}`,
    channel: { id: `C${String(i % 10).padStart(10, '0')}`, name: `ch-${i % 10}` },
    user: `U${String(i % 50).padStart(10, '0')}`,
    username: `user${i}`,
    text: `Match ${i}: agents and tools discussion thread about something important.`,
    permalink: `https://teros.slack.com/archives/C${i % 10}/p${1715000000 + i}`,
    score: 10 - i * 0.1,
  };
}

function mockSearchFileHit(i: number) {
  return {
    id: `F${String(i).padStart(10, '0')}`,
    name: `file-${i}.png`,
    title: `Diagram ${i}`,
    mimetype: 'image/png',
    permalink: `https://teros.slack.com/files/U/F${i}/file.png`,
    thumb_64: `https://files.slack.com/F${i}/thumb_64.png`,
    score: 10 - i * 0.1,
    created: 1715000000 + i,
  };
}

describe('payload size budgets (regression)', () => {
  it('list-channels 100 channels → < 48KB curated', () => {
    const raw = Array.from({ length: 100 }, (_, i) => mockSlackChannel(i));
    const curated = raw.map(extractChannel);
    expect(JSON.stringify(curated).length).toBeLessThan(48_000);
  });

  it('list-messages 100 msgs incl. threads + reactions → < 50KB curated', () => {
    const raw = Array.from({ length: 100 }, (_, i) => mockSlackMessage(i, 'C00'));
    const curated = raw.map((m) => extractMessage(m, { channel: 'C00' }));
    expect(JSON.stringify(curated).length).toBeLessThan(50_000);
  });

  it('list-users 100 users → < 48KB curated', () => {
    const raw = Array.from({ length: 100 }, (_, i) => mockSlackUser(i));
    const curated = raw.map(extractUser);
    expect(JSON.stringify(curated).length).toBeLessThan(48_000);
  });

  it('list-files 50 files → < 28KB curated', () => {
    const raw = Array.from({ length: 50 }, (_, i) => mockSlackFile(i));
    const curated = raw.map((f) => extractFile(f));
    expect(JSON.stringify(curated).length).toBeLessThan(28_000);
  });

  it('search-messages 50 hits → < 20KB curated', () => {
    const raw = Array.from({ length: 50 }, (_, i) => mockSearchMessageHit(i));
    const curated = raw.map(extractSearchMessageHit);
    expect(JSON.stringify(curated).length).toBeLessThan(20_000);
  });

  it('search-files 50 hits → < 15KB curated', () => {
    const raw = Array.from({ length: 50 }, (_, i) => mockSearchFileHit(i));
    const curated = raw.map(extractSearchFileHit);
    expect(JSON.stringify(curated).length).toBeLessThan(15_000);
  });

  it('curated channels strip at least 20% of raw Slack response', () => {
    // Channels have lots of nested objects in raw (topic, purpose); curated flattens
    const raw = Array.from({ length: 100 }, (_, i) => mockSlackChannel(i));
    const curated = raw.map(extractChannel);
    const rawSize = JSON.stringify(raw).length;
    const curatedSize = JSON.stringify(curated).length;
    expect(curatedSize).toBeLessThan(rawSize * 0.8);
  });

  // Note: a "strip 60% of raw" test for users is intentionally NOT included
  // because the synthetic mock fixtures here are leaner than a real Slack
  // users.list response (which includes locale, status, presence, two_factor,
  // permissions arrays, mfa fields, etc.). Production data ratios are much
  // higher — see the channels strip test for the same pattern with richer
  // raw fixtures.
});
