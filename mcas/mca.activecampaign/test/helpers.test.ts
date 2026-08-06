import { describe, expect, test } from 'bun:test';
import {
  asNullableNumber,
  asNullableString,
  asNumber,
  asString,
  buildPaginated,
  parseCampaign,
  parseContact,
  parseDeal,
  parseList,
  parseTag,
  wrap,
} from '../src/tools/_helpers.js';

describe('asString / asNumber / asNullableX', () => {
  test('asString coerces and uses fallback', () => {
    expect(asString('abc')).toBe('abc');
    expect(asString(123)).toBe('123');
    expect(asString(null)).toBe('');
    expect(asString(undefined, 'fallback')).toBe('fallback');
  });

  test('asNumber tolerates string numbers', () => {
    expect(asNumber('42')).toBe(42);
    expect(asNumber('not-a-num', 7)).toBe(7);
    expect(asNumber(null, 0)).toBe(0);
  });

  test('asNullableNumber/asNullableString respect emptiness', () => {
    expect(asNullableNumber('')).toBeNull();
    expect(asNullableNumber('5')).toBe(5);
    expect(asNullableString('')).toBeNull();
    expect(asNullableString('hi')).toBe('hi');
  });
});

describe('parseContact', () => {
  test('maps API shape to curated shape', () => {
    const raw = {
      id: '42',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '+1 555 1234',
      cdate: '2026-01-01T00:00:00-05:00',
      udate: '2026-02-02T00:00:00-05:00',
    };
    expect(parseContact(raw)).toEqual({
      id: '42',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '+1 555 1234',
      cdate: '2026-01-01T00:00:00-05:00',
      udate: '2026-02-02T00:00:00-05:00',
    });
  });

  test('tolerates missing fields', () => {
    const c = parseContact({ id: '1' });
    expect(c.id).toBe('1');
    expect(c.email).toBe('');
    expect(c.firstName).toBe('');
  });
});

describe('parseList', () => {
  test('maps subscriber_count to subscriberCount', () => {
    const list = parseList({
      id: '7',
      name: 'Newsletter',
      stringid: 'newsletter',
      subscriber_count: 1234,
      cdate: '2026-01-01',
    });
    expect(list).toEqual({
      id: '7',
      name: 'Newsletter',
      stringid: 'newsletter',
      subscriberCount: 1234,
      cdate: '2026-01-01',
    });
  });

  test('subscriberCount is null when missing', () => {
    expect(parseList({ id: '1', name: 'L' }).subscriberCount).toBeNull();
  });
});

describe('parseCampaign', () => {
  test('aliases ActiveCampaign-specific keys to the full curated shape', () => {
    const c = parseCampaign({
      id: '1',
      name: 'Spring',
      type: 'single',
      status: '5',
      sdate: '2026-04-01T10:00:00-04:00',
      fromname: 'Jane',
      fromemail: 'jane@acme.com',
      subject: 'Hello',
      send_amt: '500',
      opens: '320',
      linkclicks: '42',
      uniqueopens: '300',
      uniquelinkclicks: '40',
      cdate: '2026-03-25',
    });
    expect(c).toEqual({
      id: '1',
      name: 'Spring',
      type: 'single',
      status: '5',
      sendDate: '2026-04-01T10:00:00-04:00',
      fromName: 'Jane',
      fromEmail: 'jane@acme.com',
      subject: 'Hello',
      totalRecipients: 500,
      totalOpens: 320,
      totalLinks: 42,
      uniqueOpens: 300,
      uniqueLinks: 40,
      cdate: '2026-03-25',
    });
  });

  test('falls back to total_amt for recipients when send_amt is absent', () => {
    expect(parseCampaign({ id: '1', total_amt: '250' }).totalRecipients).toBe(250);
  });
});

describe('parseDeal', () => {
  test('converts cents to major units, uppercases currency, full shape', () => {
    const d = parseDeal({
      id: '9',
      title: 'Big sale',
      description: 'desc',
      value: '150000',
      currency: 'usd',
      status: '1',
      contact: '42',
      account: 'acc-1',
      group: 'pipeline-1',
      stage: 'stage-2',
      owner: 'user-3',
      cdate: '2026-04-01',
      udate: '2026-04-02',
    });
    expect(d).toEqual({
      id: '9',
      title: 'Big sale',
      description: 'desc',
      value: 1500,
      currency: 'USD',
      status: 1,
      contact: '42',
      account: 'acc-1',
      pipeline: 'pipeline-1',
      stage: 'stage-2',
      owner: 'user-3',
      cdate: '2026-04-01',
      udate: '2026-04-02',
    });
  });

  test('default currency is USD when missing', () => {
    expect(parseDeal({ id: '1', value: '100' }).currency).toBe('USD');
  });
});

describe('parseTag', () => {
  test('uses tag field when name missing', () => {
    expect(parseTag({ id: '1', tag: 'vip', tagType: 'contact' })).toEqual({
      id: '1',
      name: 'vip',
      description: '',
      tagType: 'contact',
      cdate: '',
    });
  });

  test('default tagType is contact', () => {
    expect(parseTag({ id: '1', name: 't' }).tagType).toBe('contact');
  });
});

describe('buildPaginated', () => {
  test('computes nextOffset when more remain', () => {
    const data = buildPaginated([1, 2, 3], { total: 10 }, 0, 3);
    expect(data.total).toBe(10);
    expect(data.nextOffset).toBe(3);
  });

  test('nextOffset is null when at end', () => {
    const data = buildPaginated([1, 2], { total: 5 }, 3, 2);
    expect(data.nextOffset).toBeNull();
  });

  test('total null when meta missing', () => {
    const data = buildPaginated([1], null, 0, 1);
    expect(data.total).toBeNull();
    expect(data.nextOffset).toBeNull();
  });

  test('nextOffset is null when no items returned, even if total exceeds offset', () => {
    // Guards against a re-fetch loop: a filtered total can overcount, but an
    // empty page means there is nothing more to consume.
    const data = buildPaginated([], { total: 100 }, 0, 20);
    expect(data.total).toBe(100);
    expect(data.nextOffset).toBeNull();
  });
});

describe('wrap', () => {
  test('returns content + structuredContent', () => {
    const out = wrap({ x: 1 });
    expect(out.structuredContent).toEqual({ x: 1 });
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text)).toEqual({ x: 1 });
  });

  test('attaches raw when includeRaw', () => {
    const out = wrap({ x: 1 }, { foo: 'bar' });
    expect(out.structuredContent).toEqual({ x: 1, raw: { foo: 'bar' } });
  });
});
