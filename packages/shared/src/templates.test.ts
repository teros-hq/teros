import { describe, expect, it } from 'bun:test';
import { renderNowVariable, renderTemplate, templateFields, validateTemplate } from './templates';

const payload = { fromName: 'Ada', fromUsername: 'ada', fromId: '42', text: 'hola', nested: { a: [{ b: 'deep' }] }, empty: '' };

describe('renderTemplate', () => {
  it('resolves fields, payload.* paths, dot paths and topic', () => {
    expect(renderTemplate('{{fromName}} / {{payload.text}} / {{nested.a.0.b}} / {{topic}}', payload, { topic: 't.x' })).toBe('Ada / hola / deep / t.x');
  });
  it('dumps the whole payload with {{payload}} and stringifies non-strings', () => {
    expect(renderTemplate('{{payload}}', { a: 1 })).toBe('{"a":1}');
    expect(renderTemplate('n={{n}}', { n: 3 })).toBe('n=3');
  });
  it('fallback chain: first non-empty wins, quoted literal as last resort', () => {
    expect(renderTemplate('{{fromName || fromUsername || fromId}}', payload)).toBe('Ada');
    expect(renderTemplate('{{missing || fromUsername}}', payload)).toBe('ada');
    expect(renderTemplate('{{missing || empty || "unknown"}}', payload)).toBe('unknown');
    expect(renderTemplate("{{missing || 'x'}}", payload)).toBe('x');
  });
  it('unknown paths and unsupported constructs render empty, never throw', () => {
    expect(renderTemplate('[{{nope}}]', payload)).toBe('[]');
    expect(renderTemplate('{{#if x}}y{{/if}}', payload)).toBe('y');
  });
});

describe('now.* variables', () => {
  // 2026-10-21T16:00Z = 18:00 in Madrid (CEST, +02:00, summer)
  const summer = { iso: '2026-10-21T16:00:00.000Z', timezone: 'Europe/Madrid' };
  // 2026-01-21T16:00Z = 17:00 in Madrid (CET, +01:00, winter)
  const winter = { iso: '2026-01-21T16:00:00.000Z', timezone: 'Europe/Madrid' };
  const utc = { iso: '2026-10-21T16:00:00.000Z' };

  it('renders {{now}} and {{now.datetime}} as YYYY-MM-DD HH:mm in the trigger timezone', () => {
    expect(renderTemplate('{{now}}', {}, { now: summer })).toBe('2026-10-21 18:00');
    expect(renderTemplate('{{now.datetime}}', {}, { now: summer })).toBe('2026-10-21 18:00');
  });
  it('renders {{now.date}} and {{now.time}} in the trigger timezone', () => {
    expect(renderTemplate('{{now.date}} {{now.time}}', {}, { now: summer })).toBe('2026-10-21 18:00');
    expect(renderTemplate('{{now.date}} {{now.time}}', {}, { now: winter })).toBe('2026-01-21 17:00');
  });
  it('respects DST: Europe/Madrid is +02:00 in summer and +01:00 in winter', () => {
    expect(renderTemplate('{{now.hour}}:{{now.minute}}', {}, { now: summer })).toBe('18:00');
    expect(renderTemplate('{{now.hour}}:{{now.minute}}', {}, { now: winter })).toBe('17:00');
  });
  it('renders year/month/day/hour/minute zero-padded', () => {
    expect(renderTemplate('{{now.year}}-{{now.month}}-{{now.day}}', {}, { now: winter })).toBe('2026-01-21');
    expect(renderTemplate('{{now.hour}}:{{now.minute}}', {}, { now: winter })).toBe('17:00');
  });
  it('renders {{now.weekday}} in English', () => {
    // 2026-10-21 is a Wednesday
    expect(renderTemplate('{{now.weekday}}', {}, { now: summer })).toBe('Wednesday');
    // 2026-01-21 is a Wednesday too; use a known Tuesday
    expect(renderTemplate('{{now.weekday}}', {}, { now: { iso: '2026-10-20T16:00:00.000Z', timezone: 'Europe/Madrid' } })).toBe('Tuesday');
  });
  it('renders {{now.iso}} always in UTC regardless of timezone', () => {
    expect(renderTemplate('{{now.iso}}', {}, { now: summer })).toBe('2026-10-21T16:00:00.000Z');
    expect(renderTemplate('{{now.iso}}', {}, { now: winter })).toBe('2026-01-21T16:00:00.000Z');
  });
  it('defaults to UTC when the context has no timezone', () => {
    expect(renderTemplate('{{now.date}} {{now.time}}', {}, { now: utc })).toBe('2026-10-21 16:00');
  });
  it('renders empty without now context, and unknown now.* sub-paths render empty', () => {
    expect(renderTemplate('[{{now}}]', {})).toBe('[]');
    expect(renderTemplate('[{{now.date}}]', {})).toBe('[]');
    expect(renderTemplate('[{{now.nope}}]', {}, { now: utc })).toBe('[]');
  });
  it('a payload field named now does NOT override the now context', () => {
    expect(renderTemplate('{{now.date}}', { now: 'PAYLOAD-WINS' }, { now: utc })).toBe('2026-10-21');
    expect(renderTemplate('{{now}}', { now: { iso: '1999-01-01T00:00:00.000Z' } }, { now: utc })).toBe('2026-10-21 16:00');
    // no now context → degraded to empty, like unknown paths (payload is never consulted)
    expect(renderTemplate('{{now.date}}', { now: { date: 'from-payload' } })).toBe('');
  });
  it('now.* works inside fallback chains', () => {
    expect(renderTemplate('{{payload.missing || now.date}}', {}, { now: utc })).toBe('2026-10-21');
    expect(renderTemplate('{{payload.title || now.datetime}}', { title: 'T' }, { now: utc })).toBe('T');
  });
  it('invalid now.iso renders empty, never throws', () => {
    expect(renderTemplate('[{{now.date}}]', {}, { now: { iso: 'not-a-date' } })).toBe('[]');
  });
  it('renderNowVariable maps every documented sub-path', () => {
    expect(renderNowVariable('', utc)).toBe('2026-10-21 16:00');
    expect(renderNowVariable('datetime', utc)).toBe('2026-10-21 16:00');
    expect(renderNowVariable('date', utc)).toBe('2026-10-21');
    expect(renderNowVariable('time', utc)).toBe('16:00');
    expect(renderNowVariable('iso', utc)).toBe('2026-10-21T16:00:00.000Z');
    expect(renderNowVariable('year', utc)).toBe('2026');
    expect(renderNowVariable('month', utc)).toBe('10');
    expect(renderNowVariable('day', utc)).toBe('21');
    expect(renderNowVariable('hour', utc)).toBe('16');
    expect(renderNowVariable('minute', utc)).toBe('00');
    expect(renderNowVariable('weekday', utc)).toBe('Wednesday');
    expect(renderNowVariable('nope', utc)).toBeUndefined();
  });
});

describe('validateTemplate', () => {
  it('accepts the grammar and reports the fields read', () => {
    const v = validateTemplate('From {{fromName || fromUsername || "?"}}: {{payload.text}} ({{topic}}) {{payload}}');
    expect(v.ok).toBe(true);
    expect(v.fields.sort()).toEqual(['fromName', 'fromUsername', 'text']);
  });
  it('accepts now.* and does not count it as a payload field', () => {
    const v = validateTemplate('{{now.date}} {{now.time}} {{now.iso}} {{now.weekday}} {{now.year}}{{now.month}}{{now.day}}{{now.hour}}{{now.minute}} {{now.datetime}} {{now}}');
    expect(v.ok).toBe(true);
    expect(v.fields).toEqual([]);
    const v2 = validateTemplate('{{payload.title || now.date}}');
    expect(v2.ok).toBe(true);
    expect(v2.fields).toEqual(['title']);
  });
  it('rejects handlebars blocks, empty placeholders, junk and unbalanced braces', () => {
    expect(validateTemplate('{{#if a}}{{a}}{{/if}}').ok).toBe(false);
    expect(validateTemplate('{{else}}').ok).toBe(false);
    expect(validateTemplate('{{}}').ok).toBe(false);
    expect(validateTemplate('{{a | upper}}').ok).toBe(false);
    expect(validateTemplate('{{a || }}').ok).toBe(false);
    expect(validateTemplate('{{a').ok).toBe(false);
    expect(validateTemplate('{{#if a}}').error).toContain('unsupported block syntax');
  });
  it('templateFields is empty for invalid or absent templates', () => {
    expect(templateFields('{{#if a}}')).toEqual([]);
    expect(templateFields(undefined)).toEqual([]);
    expect(templateFields('{{a.b}} {{payload.c}}')).toEqual(['a', 'c']);
  });
});
