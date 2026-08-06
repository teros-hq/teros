import { describe, expect, it } from 'bun:test';
import {
  buildCampaignBody,
  buildSendTestBody,
  validateCreateCampaignArgs,
  validateSendTestArgs,
} from '../../src/tools/_helpers';

const validCampaign = {
  name: 'May Newsletter',
  subject: 'Spring deals',
  sender: { email: 'news@empresa.com' },
  htmlContent: '<h1>Hello</h1><p>Deals inside.</p>',
};

// ============================================================================
// create-email-campaign — validation
// ============================================================================

describe('validateCreateCampaignArgs', () => {
  it('passes with htmlContent, templateId or htmlUrl (exactly one)', () => {
    expect(() => validateCreateCampaignArgs(validCampaign)).not.toThrow();
    expect(() =>
      validateCreateCampaignArgs({ ...validCampaign, htmlContent: undefined, templateId: 12 }),
    ).not.toThrow();
    expect(() =>
      validateCreateCampaignArgs({
        ...validCampaign,
        htmlContent: undefined,
        htmlUrl: 'https://cdn.example.com/n.html',
      }),
    ).not.toThrow();
  });

  it('rejects missing name / subject / sender', () => {
    expect(() => validateCreateCampaignArgs({ ...validCampaign, name: '  ' })).toThrow(/name is required/);
    expect(() => validateCreateCampaignArgs({ ...validCampaign, subject: '' })).toThrow(/subject is required/);
    expect(() => validateCreateCampaignArgs({ ...validCampaign, sender: {} })).toThrow(/sender requires/);
  });

  it('rejects zero content sources', () => {
    expect(() => validateCreateCampaignArgs({ ...validCampaign, htmlContent: undefined })).toThrow(
      /exactly one of htmlContent, htmlUrl or templateId/,
    );
  });

  it('rejects more than one content source (mutually exclusive)', () => {
    expect(() => validateCreateCampaignArgs({ ...validCampaign, templateId: 5 })).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects htmlContent shorter than 10 chars and non-http htmlUrl', () => {
    expect(() => validateCreateCampaignArgs({ ...validCampaign, htmlContent: '<p>hi</p>' })).toThrow(
      /at least 10 characters/,
    );
    expect(() =>
      validateCreateCampaignArgs({
        ...validCampaign,
        htmlContent: undefined,
        htmlUrl: 'javascript:alert(1)',
      }),
    ).toThrow(/htmlUrl must be a valid http/);
  });

  it('rejects non-integer recipient id arrays', () => {
    expect(() =>
      validateCreateCampaignArgs({ ...validCampaign, recipients: { listIds: [1, 'x'] } }),
    ).toThrow(/recipients\.listIds/);
    expect(() =>
      validateCreateCampaignArgs({ ...validCampaign, recipients: { segmentIds: 3 } }),
    ).toThrow(/recipients\.segmentIds/);
  });

  it('requires recipients.listIds when scheduledAt is set', () => {
    expect(() =>
      validateCreateCampaignArgs({ ...validCampaign, scheduledAt: '2026-06-01T10:00:00Z' }),
    ).toThrow(/recipients\.listIds is required when scheduledAt/);
    expect(() =>
      validateCreateCampaignArgs({
        ...validCampaign,
        scheduledAt: '2026-06-01T10:00:00Z',
        recipients: { listIds: [7] },
      }),
    ).not.toThrow();
  });

  it('rejects a malformed replyTo', () => {
    expect(() => validateCreateCampaignArgs({ ...validCampaign, replyTo: 'bad' })).toThrow(/replyTo/);
  });
});

// ============================================================================
// create-email-campaign — body build (exact payload)
// ============================================================================

describe('buildCampaignBody', () => {
  it('builds a minimal body with no undefined keys', () => {
    const body = buildCampaignBody(validCampaign);
    expect(body).toEqual({
      name: 'May Newsletter',
      sender: { email: 'news@empresa.com' },
      subject: 'Spring deals',
      htmlContent: '<h1>Hello</h1><p>Deals inside.</p>',
    });
    expect('recipients' in body).toBe(false);
    expect('scheduledAt' in body).toBe(false);
  });

  it('builds the full body verbatim with recipients and schedule', () => {
    const body = buildCampaignBody({
      name: '  Promo  ',
      subject: '  Big sale  ',
      sender: { id: 3, name: 'Store' },
      templateId: 42,
      recipients: { listIds: [1, 2], exclusionListIds: [9], segmentIds: [5] },
      scheduledAt: '2026-06-01T10:00:00Z',
      replyTo: 'reply@empresa.com',
      toField: '{FNAME}',
      tag: '  promo  ',
      previewText: 'Peek inside',
    });
    expect(body).toEqual({
      name: 'Promo',
      subject: 'Big sale',
      sender: { id: 3, name: 'Store' },
      templateId: 42,
      recipients: { listIds: [1, 2], exclusionListIds: [9], segmentIds: [5] },
      scheduledAt: '2026-06-01T10:00:00Z',
      replyTo: 'reply@empresa.com',
      toField: '{FNAME}',
      tag: 'promo',
      previewText: 'Peek inside',
    });
  });

  it('omits empty recipient arrays (no empty recipients object)', () => {
    const body = buildCampaignBody({
      ...validCampaign,
      recipients: { listIds: [], exclusionListIds: [], segmentIds: [] },
    });
    expect('recipients' in body).toBe(false);
  });

  it('keeps only the populated recipient keys', () => {
    const body = buildCampaignBody({ ...validCampaign, recipients: { listIds: [4] } });
    expect(body.recipients).toEqual({ listIds: [4] });
  });
});

// ============================================================================
// send-test-email
// ============================================================================

describe('validateSendTestArgs', () => {
  it('passes for a valid campaignId + emailTo', () => {
    expect(() => validateSendTestArgs({ campaignId: 10, emailTo: ['a@b.com'] })).not.toThrow();
    expect(() => validateSendTestArgs({ campaignId: '10', emailTo: ['a@b.com'] })).not.toThrow();
  });
  it('rejects missing campaignId', () => {
    expect(() => validateSendTestArgs({ emailTo: ['a@b.com'] })).toThrow(/campaignId is required/);
  });
  it('rejects an empty or invalid emailTo', () => {
    expect(() => validateSendTestArgs({ campaignId: 1, emailTo: [] })).toThrow(/emailTo is required/);
    expect(() => validateSendTestArgs({ campaignId: 1, emailTo: ['ok@x.com', 'bad'] })).toThrow(
      /emailTo\[1\]/,
    );
  });
  it('rejects more than 99 recipients', () => {
    const many = Array.from({ length: 100 }, (_, i) => `u${i}@x.com`);
    expect(() => validateSendTestArgs({ campaignId: 1, emailTo: many })).toThrow(/at most 99/);
  });
});

describe('buildSendTestBody', () => {
  it('trims the recipient addresses', () => {
    expect(buildSendTestBody({ campaignId: 1, emailTo: ['  a@b.com  ', 'c@d.com'] })).toEqual({
      emailTo: ['a@b.com', 'c@d.com'],
    });
  });
});
