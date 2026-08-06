import { describe, expect, it } from 'bun:test';
import {
  buildCreateListBody,
  buildCreateTemplateBody,
  coerceInt,
  shapeFolder,
  shapeList,
  shapeTemplate,
  validateCreateListArgs,
  validateCreateTemplateArgs,
} from '../../src/tools/_helpers';

// ============================================================================
// coerceInt
// ============================================================================

describe('coerceInt', () => {
  it('accepts real integers', () => {
    expect(coerceInt(0)).toBe(0);
    expect(coerceInt(42)).toBe(42);
    expect(coerceInt(-3)).toBe(-3);
  });
  it('accepts integer-valued numeric strings', () => {
    expect(coerceInt('7')).toBe(7);
    expect(coerceInt('  12  ')).toBe(12);
  });
  it('rejects floats, non-numeric strings, and non-numbers', () => {
    expect(coerceInt(2.5)).toBeNull();
    expect(coerceInt('2.5')).toBeNull();
    expect(coerceInt('abc')).toBeNull();
    expect(coerceInt('')).toBeNull();
    expect(coerceInt(null)).toBeNull();
    expect(coerceInt(undefined)).toBeNull();
    expect(coerceInt(Number.NaN)).toBeNull();
    expect(coerceInt({})).toBeNull();
  });
});

// ============================================================================
// create-list
// ============================================================================

describe('validateCreateListArgs', () => {
  it('passes with name + integer folderId', () => {
    expect(() => validateCreateListArgs({ name: 'VIP', folderId: 2 })).not.toThrow();
  });
  it('passes with a numeric-string folderId (LLM stringified id)', () => {
    expect(() => validateCreateListArgs({ name: 'VIP', folderId: '2' })).not.toThrow();
  });
  it('rejects missing / blank name', () => {
    expect(() => validateCreateListArgs({ folderId: 2 })).toThrow(/name is required/);
    expect(() => validateCreateListArgs({ name: '   ', folderId: 2 })).toThrow(/name is required/);
  });
  it('rejects missing folderId', () => {
    expect(() => validateCreateListArgs({ name: 'VIP' })).toThrow(/folderId is required/);
  });
  it('rejects a non-integer folderId', () => {
    expect(() => validateCreateListArgs({ name: 'VIP', folderId: 2.5 })).toThrow(/folderId/);
    expect(() => validateCreateListArgs({ name: 'VIP', folderId: 'abc' })).toThrow(/folderId/);
  });
});

describe('buildCreateListBody', () => {
  it('builds the exact body and trims the name', () => {
    expect(buildCreateListBody({ name: '  VIP Customers  ', folderId: 2 })).toEqual({
      name: 'VIP Customers',
      folderId: 2,
    });
  });
  it('coerces a numeric-string folderId to a number', () => {
    const body = buildCreateListBody({ name: 'X', folderId: '9' });
    expect(body).toEqual({ name: 'X', folderId: 9 });
    expect(typeof body.folderId).toBe('number');
  });
});

// ============================================================================
// create-email-template
// ============================================================================

const validTemplate = {
  templateName: 'Welcome',
  subject: 'Welcome {{FNAME}}',
  sender: { email: 'noreply@empresa.com' },
  htmlContent: '<p>Hola {{FNAME}}</p>',
};

describe('validateCreateTemplateArgs', () => {
  it('passes for a valid email-sender template', () => {
    expect(() => validateCreateTemplateArgs(validTemplate)).not.toThrow();
  });
  it('passes with a sender id instead of email', () => {
    expect(() =>
      validateCreateTemplateArgs({ ...validTemplate, sender: { id: 5 } }),
    ).not.toThrow();
  });
  it('passes with htmlUrl instead of htmlContent', () => {
    expect(() =>
      validateCreateTemplateArgs({
        ...validTemplate,
        htmlContent: undefined,
        htmlUrl: 'https://cdn.example.com/t.html',
      }),
    ).not.toThrow();
  });
  it('rejects missing templateName / subject', () => {
    expect(() => validateCreateTemplateArgs({ ...validTemplate, templateName: '  ' })).toThrow(
      /templateName is required/,
    );
    expect(() => validateCreateTemplateArgs({ ...validTemplate, subject: '' })).toThrow(
      /subject is required/,
    );
  });
  it('rejects a sender with neither email nor id', () => {
    expect(() => validateCreateTemplateArgs({ ...validTemplate, sender: {} })).toThrow(
      /sender requires either/,
    );
    expect(() => validateCreateTemplateArgs({ ...validTemplate, sender: 'x' })).toThrow(/sender/);
  });
  it('rejects a sender with BOTH email and id (mutex)', () => {
    expect(() =>
      validateCreateTemplateArgs({ ...validTemplate, sender: { email: 'a@b.com', id: 5 } }),
    ).toThrow(/not both/);
  });
  it('rejects a malformed sender.email', () => {
    expect(() =>
      validateCreateTemplateArgs({ ...validTemplate, sender: { email: 'nope' } }),
    ).toThrow(/not a valid email/);
  });
  it('rejects when neither htmlContent nor htmlUrl is present', () => {
    expect(() =>
      validateCreateTemplateArgs({ ...validTemplate, htmlContent: undefined, htmlUrl: undefined }),
    ).toThrow(/At least one of htmlContent or htmlUrl/);
  });
  it('rejects htmlContent shorter than 10 characters', () => {
    expect(() => validateCreateTemplateArgs({ ...validTemplate, htmlContent: '<p>hi</p>' })).toThrow(
      /at least 10 characters/,
    );
  });
  it('rejects a non-http htmlUrl (protocol whitelist)', () => {
    expect(() =>
      validateCreateTemplateArgs({
        ...validTemplate,
        htmlContent: undefined,
        htmlUrl: 'javascript:alert(1)',
      }),
    ).toThrow(/htmlUrl must be a valid http/);
  });
  it('rejects a non-http attachmentUrl and a malformed replyTo', () => {
    expect(() =>
      validateCreateTemplateArgs({ ...validTemplate, attachmentUrl: 'ftp://x/y.pdf' }),
    ).toThrow(/attachmentUrl/);
    expect(() => validateCreateTemplateArgs({ ...validTemplate, replyTo: 'bad' })).toThrow(
      /replyTo/,
    );
  });
});

describe('buildCreateTemplateBody', () => {
  it('builds a minimal body with no undefined keys', () => {
    const body = buildCreateTemplateBody(validTemplate);
    expect(body).toEqual({
      templateName: 'Welcome',
      subject: 'Welcome {{FNAME}}',
      sender: { email: 'noreply@empresa.com' },
      htmlContent: '<p>Hola {{FNAME}}</p>',
    });
    expect('isActive' in body).toBe(false);
    expect('replyTo' in body).toBe(false);
    expect('htmlUrl' in body).toBe(false);
  });

  it('builds the full body verbatim and keeps isActive:false', () => {
    const body = buildCreateTemplateBody({
      templateName: '  Order  ',
      subject: '  Thanks  ',
      sender: { id: 7, name: 'Store' },
      htmlUrl: 'https://cdn.example.com/o.html',
      isActive: false,
      replyTo: 'support@empresa.com',
      toField: '{{contact.FNAME}}',
      tag: '  orders  ',
      attachmentUrl: 'https://cdn.example.com/receipt.pdf',
    });
    expect(body).toEqual({
      templateName: 'Order',
      subject: 'Thanks',
      sender: { id: 7, name: 'Store' },
      htmlUrl: 'https://cdn.example.com/o.html',
      isActive: false,
      replyTo: 'support@empresa.com',
      toField: '{{contact.FNAME}}',
      tag: 'orders',
      attachmentUrl: 'https://cdn.example.com/receipt.pdf',
    });
  });

  it('coerces a numeric-string sender id and trims the email', () => {
    const body = buildCreateTemplateBody({
      ...validTemplate,
      sender: { email: '  a@b.com  ' },
    });
    expect(body.sender).toEqual({ email: 'a@b.com' });

    const idBody = buildCreateTemplateBody({ ...validTemplate, sender: { id: '9' } });
    expect(idBody.sender).toEqual({ id: 9 });
    expect(typeof (idBody.sender as { id: number }).id).toBe('number');
  });
});

// ============================================================================
// Response shaping
// ============================================================================

describe('shapeFolder', () => {
  it('whitelists the folder fields', () => {
    expect(
      shapeFolder({
        id: 1,
        name: 'My folder',
        totalSubscribers: 10,
        uniqueSubscribers: 9,
        totalBlacklisted: 1,
        // extraneous field must be dropped
        internalToken: 'secret',
      }),
    ).toEqual({
      id: 1,
      name: 'My folder',
      totalSubscribers: 10,
      uniqueSubscribers: 9,
      totalBlacklisted: 1,
    });
  });
  it('nulls missing / wrong-typed fields', () => {
    expect(shapeFolder({})).toEqual({
      id: null,
      name: null,
      totalSubscribers: null,
      uniqueSubscribers: null,
      totalBlacklisted: null,
    });
    expect(shapeFolder(null).id).toBeNull();
  });
});

describe('shapeList', () => {
  it('whitelists the list fields including folderId', () => {
    expect(
      shapeList({
        id: 3,
        name: 'Newsletter',
        folderId: 1,
        totalSubscribers: 100,
        uniqueSubscribers: 98,
        totalBlacklisted: 2,
      }),
    ).toEqual({
      id: 3,
      name: 'Newsletter',
      folderId: 1,
      totalSubscribers: 100,
      uniqueSubscribers: 98,
      totalBlacklisted: 2,
    });
  });
  it('nulls missing fields', () => {
    expect(shapeList({ id: 3 }).folderId).toBeNull();
  });
});

describe('shapeTemplate', () => {
  it('whitelists the template fields and DROPS htmlContent (context bloat)', () => {
    const shaped = shapeTemplate({
      id: 5,
      name: 'Welcome',
      subject: 'Hi',
      isActive: true,
      testSent: false,
      sender: { email: 'a@b.com', name: 'Team', id: '9' },
      replyTo: 'r@b.com',
      toField: '{{contact.FNAME}}',
      tag: 'welcome',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z',
      htmlContent: '<p>...huge body...</p>',
    });
    expect(shaped).toEqual({
      id: 5,
      name: 'Welcome',
      subject: 'Hi',
      isActive: true,
      testSent: false,
      sender: { email: 'a@b.com', name: 'Team', id: '9' },
      replyTo: 'r@b.com',
      toField: '{{contact.FNAME}}',
      tag: 'welcome',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z',
    });
    expect('htmlContent' in shaped).toBe(false);
  });
  it('coerces a numeric sender id to string and nulls a missing sender', () => {
    expect(shapeTemplate({ sender: { id: 42 } }).sender).toEqual({
      email: null,
      name: null,
      id: '42',
    });
    expect(shapeTemplate({ id: 1 }).sender).toBeNull();
  });
});
