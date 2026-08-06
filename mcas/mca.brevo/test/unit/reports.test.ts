import { describe, expect, it } from 'bun:test';
import {
  buildAggregatedReportQuery,
  buildEmailEventQuery,
  shapeAggregatedReport,
  shapeEmailEvent,
  validateAggregatedReportArgs,
  validateEmailEventReportArgs,
} from '../../src/tools/_helpers';

// ============================================================================
// shared timeframe contract (days XOR startDate+endDate)
// ============================================================================

describe('report date-range validation (shared)', () => {
  it('accepts days alone, a full range alone, or nothing', () => {
    expect(() => validateEmailEventReportArgs({ days: 7 })).not.toThrow();
    expect(() =>
      validateEmailEventReportArgs({ startDate: '2026-01-01', endDate: '2026-01-31' }),
    ).not.toThrow();
    expect(() => validateEmailEventReportArgs({})).not.toThrow();
    // both report tools share the same validator
    expect(() => validateAggregatedReportArgs({ days: 30 })).not.toThrow();
  });

  it('rejects days combined with a date range', () => {
    expect(() =>
      validateEmailEventReportArgs({ days: 7, startDate: '2026-01-01', endDate: '2026-01-31' }),
    ).toThrow(/days is not compatible/);
    expect(() => validateAggregatedReportArgs({ days: 7, startDate: '2026-01-01' })).toThrow(
      /days is not compatible/,
    );
  });

  it('rejects a half-open range (start without end, or end without start)', () => {
    expect(() => validateEmailEventReportArgs({ startDate: '2026-01-01' })).toThrow(
      /must be provided together/,
    );
    expect(() => validateEmailEventReportArgs({ endDate: '2026-01-31' })).toThrow(
      /must be provided together/,
    );
  });

  it('rejects malformed dates and start > end', () => {
    expect(() =>
      validateEmailEventReportArgs({ startDate: '01/01/2026', endDate: '2026-01-31' }),
    ).toThrow(/startDate must be in YYYY-MM-DD/);
    expect(() =>
      validateEmailEventReportArgs({ startDate: '2026-01-01', endDate: '2026/01/31' }),
    ).toThrow(/endDate must be in YYYY-MM-DD/);
    expect(() =>
      validateEmailEventReportArgs({ startDate: '2026-02-01', endDate: '2026-01-31' }),
    ).toThrow(/startDate must be less than or equal to endDate/);
  });

  it('rejects days out of the 1-90 range or non-integer', () => {
    expect(() => validateEmailEventReportArgs({ days: 0 })).toThrow(/between 1 and 90/);
    expect(() => validateEmailEventReportArgs({ days: 91 })).toThrow(/between 1 and 90/);
    expect(() => validateEmailEventReportArgs({ days: 3.5 })).toThrow(/between 1 and 90/);
  });
});

// ============================================================================
// get-email-event-report — validation + query building
// ============================================================================

describe('validateEmailEventReportArgs', () => {
  it('passes with a full valid filter set', () => {
    expect(() =>
      validateEmailEventReportArgs({
        days: 14,
        email: 'a@b.com',
        event: 'opened',
        messageId: '<x@brevo>',
        templateId: 12,
        sort: 'asc',
      }),
    ).not.toThrow();
  });

  it('rejects an invalid email, event, sort, messageId and templateId', () => {
    expect(() => validateEmailEventReportArgs({ email: 'nope' })).toThrow(/email must be a valid/);
    expect(() => validateEmailEventReportArgs({ event: 'openedd' })).toThrow(/event must be one of/);
    expect(() => validateEmailEventReportArgs({ sort: 'up' })).toThrow(/sort must be one of/);
    expect(() => validateEmailEventReportArgs({ messageId: '   ' })).toThrow(
      /messageId must be a non-empty/,
    );
    expect(() => validateEmailEventReportArgs({ templateId: 1.5 })).toThrow(
      /templateId must be an integer/,
    );
  });
});

describe('buildEmailEventQuery', () => {
  it('builds the exact query, mapping every present filter', () => {
    expect(
      buildEmailEventQuery({
        limit: 200,
        offset: 10,
        startDate: '  2026-01-01  ',
        endDate: '2026-01-31',
        email: '  a@b.com ',
        event: 'clicks',
        messageId: '  <m>  ',
        templateId: 7,
        sort: 'asc',
      }),
    ).toEqual({
      limit: 200,
      offset: 10,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      email: 'a@b.com',
      event: 'clicks',
      messageId: '<m>',
      templateId: 7,
      sort: 'asc',
    });
  });

  it('applies defaults, clamps the limit and omits absent filters', () => {
    expect(buildEmailEventQuery({})).toEqual({ limit: 100, offset: 0 });
    expect(buildEmailEventQuery({ limit: 99999 }).limit).toBe(5000);
    expect(buildEmailEventQuery({ limit: 0 }).limit).toBe(1);
    const q = buildEmailEventQuery({ days: 5 });
    expect(q).toEqual({ limit: 100, offset: 0, days: 5 });
    expect('startDate' in q).toBe(false);
  });
});

describe('shapeEmailEvent', () => {
  it('maps the whitelisted fields and DROPS ip', () => {
    expect(
      shapeEmailEvent({
        date: '2026-01-01T10:00:00Z',
        email: 'a@b.com',
        event: 'delivered',
        messageId: '<m>',
        subject: 'Hi',
        tag: 'welcome',
        reason: null,
        link: null,
        from: 's@x.com',
        templateId: 4,
        ip: '1.2.3.4',
      }),
    ).toEqual({
      date: '2026-01-01T10:00:00Z',
      email: 'a@b.com',
      event: 'delivered',
      messageId: '<m>',
      subject: 'Hi',
      tag: 'welcome',
      reason: null,
      link: null,
      from: 's@x.com',
      templateId: 4,
    });
  });

  it('defaults missing / garbage fields to null', () => {
    expect(shapeEmailEvent(null)).toEqual({
      date: null,
      email: null,
      event: null,
      messageId: null,
      subject: null,
      tag: null,
      reason: null,
      link: null,
      from: null,
      templateId: null,
    });
  });
});

// ============================================================================
// get-aggregated-smtp-report — validation + query building + shaping
// ============================================================================

describe('validateAggregatedReportArgs', () => {
  it('passes with days + tag, rejects an empty tag', () => {
    expect(() => validateAggregatedReportArgs({ days: 30, tag: 'promo' })).not.toThrow();
    expect(() => validateAggregatedReportArgs({ tag: '   ' })).toThrow(/tag must be a non-empty/);
  });
});

describe('buildAggregatedReportQuery', () => {
  it('maps days + tag, or a full range, omitting absent', () => {
    expect(buildAggregatedReportQuery({ days: 30, tag: '  promo ' })).toEqual({
      days: 30,
      tag: 'promo',
    });
    expect(
      buildAggregatedReportQuery({ startDate: ' 2026-01-01 ', endDate: '2026-01-31' }),
    ).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(buildAggregatedReportQuery({})).toEqual({});
  });
});

describe('shapeAggregatedReport', () => {
  it('maps range + every numeric total', () => {
    expect(
      shapeAggregatedReport({
        range: '2026-01-01|2026-01-31',
        requests: 100,
        delivered: 95,
        opens: 60,
        uniqueOpens: 40,
        clicks: 20,
        uniqueClicks: 15,
        hardBounces: 2,
        softBounces: 3,
        blocked: 1,
        invalid: 0,
        spamReports: 1,
        unsubscribed: 4,
      }),
    ).toEqual({
      range: '2026-01-01|2026-01-31',
      requests: 100,
      delivered: 95,
      opens: 60,
      uniqueOpens: 40,
      clicks: 20,
      uniqueClicks: 15,
      hardBounces: 2,
      softBounces: 3,
      blocked: 1,
      invalid: 0,
      spamReports: 1,
      unsubscribed: 4,
    });
  });

  it('defaults missing / garbage numbers to null', () => {
    expect(shapeAggregatedReport({ requests: 'x' })).toEqual({
      range: null,
      requests: null,
      delivered: null,
      opens: null,
      uniqueOpens: null,
      clicks: null,
      uniqueClicks: null,
      hardBounces: null,
      softBounces: null,
      blocked: null,
      invalid: null,
      spamReports: null,
      unsubscribed: null,
    });
  });
});
