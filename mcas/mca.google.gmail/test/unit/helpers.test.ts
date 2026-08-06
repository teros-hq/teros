import { describe, expect, it } from 'bun:test';
import {
  containsMarkdown,
  createRawEmail,
  encodeAddressDisplayName,
  encodeSubject,
  findAttachments,
  findTextPart,
  getDisplayName,
  processEmailBody,
} from '../../src/helpers';

describe('getDisplayName', () => {
  it('returns undefined for empty input', () => {
    expect(getDisplayName()).toBeUndefined();
    expect(getDisplayName('')).toBeUndefined();
  });

  it('capitalizes words from email local part', () => {
    expect(getDisplayName('john.doe@example.com')).toBe('John Doe');
  });

  it('splits on dots, underscores, and hyphens', () => {
    expect(getDisplayName('jane_mary-smith@test.com')).toBe('Jane Mary Smith');
  });

  it('handles single-word local part', () => {
    expect(getDisplayName('admin@test.com')).toBe('Admin');
  });
});

describe('containsMarkdown', () => {
  it('detects headers', () => {
    expect(containsMarkdown('# Title')).toBe(true);
    expect(containsMarkdown('## Subtitle')).toBe(true);
  });

  it('detects bold', () => {
    expect(containsMarkdown('this is **bold** text')).toBe(true);
  });

  it('detects links', () => {
    expect(containsMarkdown('click [here](https://example.com)')).toBe(true);
  });

  it('detects unordered lists', () => {
    expect(containsMarkdown('- item one\n- item two')).toBe(true);
  });

  it('detects ordered lists', () => {
    expect(containsMarkdown('1. first\n2. second')).toBe(true);
  });

  it('detects code blocks', () => {
    expect(containsMarkdown('```\ncode\n```')).toBe(true);
  });

  it('detects inline code', () => {
    expect(containsMarkdown('use `npm install`')).toBe(true);
  });

  it('detects blockquotes', () => {
    expect(containsMarkdown('> quoted text')).toBe(true);
  });

  it('detects tables', () => {
    expect(containsMarkdown('| col1 | col2 |')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(containsMarkdown('Hello, this is plain text.')).toBe(false);
  });
});

describe('encodeSubject', () => {
  it('returns ASCII subjects unchanged', () => {
    expect(encodeSubject('Hello World')).toBe('Hello World');
  });

  it('encodes non-ASCII subjects as UTF-8 base64', () => {
    const encoded = encodeSubject('Café résumé');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe('encodeAddressDisplayName', () => {
  it('returns plain email unchanged', () => {
    expect(encodeAddressDisplayName('user@example.com')).toBe('user@example.com');
  });

  it('returns ASCII display name unchanged', () => {
    const addr = '"John Doe" <john@example.com>';
    expect(encodeAddressDisplayName(addr)).toBe(addr);
  });

  it('encodes non-ASCII display name', () => {
    const addr = '"Toño García" <tono@example.com>';
    const encoded = encodeAddressDisplayName(addr);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?= <tono@example\.com>$/);
  });
});

describe('createRawEmail', () => {
  it('produces a base64url-encoded string', () => {
    const raw = createRawEmail('to@test.com', 'Subject', 'Body', 'from@test.com');
    expect(raw).not.toContain('+');
    expect(raw).not.toContain('/');
    expect(raw).not.toContain('=');
  });

  it('includes To/From/Subject headers when decoded', () => {
    const raw = createRawEmail('to@test.com', 'Test Subject', 'Body', 'from@test.com');
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(decoded).toContain('To: to@test.com');
    expect(decoded).toContain('From: from@test.com');
    expect(decoded).toContain('Subject: Test Subject');
    expect(decoded).toContain('Content-Type: text/plain');
  });

  it('sets Content-Type to html when isHtml is true', () => {
    const raw = createRawEmail('to@test.com', 'Sub', '<b>Hi</b>', 'from@test.com', { isHtml: true });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(decoded).toContain('Content-Type: text/html');
  });

  it('includes cc, bcc, In-Reply-To, References headers', () => {
    const raw = createRawEmail('to@test.com', 'Sub', 'Body', 'from@test.com', {
      cc: 'cc@test.com',
      bcc: 'bcc@test.com',
      inReplyTo: '<msg-123@test.com>',
      references: '<msg-000@test.com>',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(decoded).toContain('Cc: cc@test.com');
    expect(decoded).toContain('Bcc: bcc@test.com');
    expect(decoded).toContain('In-Reply-To: <msg-123@test.com>');
    expect(decoded).toContain('References: <msg-000@test.com>');
  });

  it('includes display name in From header', () => {
    const raw = createRawEmail('to@test.com', 'Sub', 'Body', 'from@test.com', { fromName: 'John Doe' });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(decoded).toContain('John Doe');
  });
});

describe('findTextPart', () => {
  it('extracts text from simple body', () => {
    const encoded = Buffer.from('Hello world').toString('base64');
    const part = { body: { data: encoded } };
    expect(findTextPart(part)).toBe('Hello world');
  });

  it('prefers text/plain over text/html in multipart', () => {
    const plain = Buffer.from('Plain text').toString('base64');
    const html = Buffer.from('<b>HTML</b>').toString('base64');
    const part = {
      parts: [
        { mimeType: 'text/html', body: { data: html } },
        { mimeType: 'text/plain', body: { data: plain } },
      ],
    };
    expect(findTextPart(part)).toBe('Plain text');
  });

  it('falls back to text/html if no plain', () => {
    const html = Buffer.from('<b>HTML</b>').toString('base64');
    const part = {
      parts: [{ mimeType: 'text/html', body: { data: html } }],
    };
    expect(findTextPart(part)).toBe('<b>HTML</b>');
  });

  it('recurses into nested parts', () => {
    const text = Buffer.from('Nested content').toString('base64');
    const part = {
      parts: [
        {
          parts: [{ mimeType: 'text/plain', body: { data: text } }],
        },
      ],
    };
    expect(findTextPart(part)).toBe('Nested content');
  });

  it('returns empty string for no content', () => {
    expect(findTextPart({})).toBe('');
  });
});

describe('findAttachments', () => {
  it('returns empty for no attachments', () => {
    expect(findAttachments({})).toEqual([]);
  });

  it('finds attachment with filename and attachmentId', () => {
    const part = {
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      body: { attachmentId: 'att-123', size: 1024 },
    };
    const result = findAttachments(part);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      attachmentId: 'att-123',
      size: 1024,
    });
  });

  it('finds attachments in nested parts', () => {
    const part = {
      parts: [
        { filename: 'a.txt', mimeType: 'text/plain', body: { attachmentId: '1', size: 100 } },
        {
          parts: [
            { filename: 'b.png', mimeType: 'image/png', body: { attachmentId: '2', size: 200 } },
          ],
        },
      ],
    };
    const result = findAttachments(part);
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('a.txt');
    expect(result[1].filename).toBe('b.png');
  });
});

describe('processEmailBody', () => {
  it('returns HTML as-is when explicitIsHtml is true', async () => {
    const result = await processEmailBody('<b>Hello</b>', true);
    expect(result.body).toBe('<b>Hello</b>');
    expect(result.isHtml).toBe(true);
  });

  it('returns plain text as-is when no markdown', async () => {
    const result = await processEmailBody('Hello world', false);
    expect(result.body).toBe('Hello world');
    expect(result.isHtml).toBe(false);
  });

  it('auto-converts markdown to HTML', async () => {
    const result = await processEmailBody('# Hello\n\nThis is **bold**');
    expect(result.isHtml).toBe(true);
    expect(result.body).toContain('<h1>');
    expect(result.body).toContain('<strong>bold</strong>');
  });

  it('detects and converts markdown even when explicitIsHtml is false', async () => {
    const result = await processEmailBody('# Heading\n\n- item', false);
    expect(result.isHtml).toBe(true);
    expect(result.body).toContain('<h1>');
  });

  it('returns plain text when no markdown detected and no flag', async () => {
    const result = await processEmailBody('Just a simple sentence.');
    expect(result.isHtml).toBe(false);
    expect(result.body).toBe('Just a simple sentence.');
  });
});
