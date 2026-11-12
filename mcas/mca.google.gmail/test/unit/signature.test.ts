import { describe, expect, it } from 'bun:test';
import {
  appendSignature,
  looksLikeHtml,
  resolveSignatureHtml,
  signatureToPlainText,
  withSignature,
} from '../../src/signature';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SIGNATURE_HTML =
  '<table style="border-collapse:collapse"><tr><td><img src="https://example.com/logo.png" alt="Acme" width="120"></td><td style="padding-left:12px"><strong>Alex Doe</strong><br>Frontend Developer — FDE<br><a href="https://acme.example.com">acme.example.com</a></td></tr></table>';

describe('looksLikeHtml', () => {
  it('detects common HTML markup', () => {
    expect(looksLikeHtml('<html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtml('<div>hi</div>')).toBe(true);
    expect(looksLikeHtml('<table><tr><td>cell</td></tr></table>')).toBe(true);
    expect(looksLikeHtml('<img src="https://x.com/l.png">')).toBe(true);
    expect(looksLikeHtml('<p>hello</p>')).toBe(true);
  });

  it('does not flag plain text or Markdown', () => {
    expect(looksLikeHtml('Hello, plain text here.')).toBe(false);
    expect(looksLikeHtml('# Title\n\n**bold** markdown')).toBe(false);
    expect(looksLikeHtml('- item one\n- item two')).toBe(false);
    expect(looksLikeHtml('a < b and b > c is math, not HTML')).toBe(false);
  });
});

describe('appendSignature', () => {
  it('appends the signature to an HTML body before </body>', () => {
    const body = '<html><body><p>Hello</p></body></html>';
    const result = appendSignature(body, SIGNATURE_HTML, true);
    expect(result).toContain('<!-- teros-signature -->');
    expect(result.indexOf(SIGNATURE_HTML)).toBeLessThan(result.indexOf('</body>'));
    expect(result).toContain('<p>Hello</p>');
  });

  it('appends at the end when there is no </body> tag', () => {
    const body = '<p>Hello</p>';
    const result = appendSignature(body, SIGNATURE_HTML, true);
    expect(result).toContain('<!-- teros-signature -->');
    expect(result.endsWith(SIGNATURE_HTML + '\n')).toBe(true);
  });

  it('does not duplicate an already-inserted signature (dedupe)', () => {
    const once = appendSignature('<p>Hello</p>', SIGNATURE_HTML, true);
    const twice = appendSignature(once, SIGNATURE_HTML, true);
    expect(twice).toBe(once);
    expect(twice.match(/<!-- teros-signature -->/g)?.length).toBe(1);
  });

  it('appends to a plain-text body after a blank line', () => {
    const result = appendSignature('Hello', SIGNATURE_HTML, false);
    expect(result.startsWith('Hello\n\n<!-- teros-signature -->')).toBe(true);
  });

  it('returns the body unchanged when no signature is configured', () => {
    expect(appendSignature('<p>Hello</p>', undefined, true)).toBe('<p>Hello</p>');
    expect(appendSignature('Hello', '   ', false)).toBe('Hello');
  });

  it('preserves signature markup verbatim (tables, inline styles, img)', () => {
    const result = appendSignature('<p>Hello</p>', SIGNATURE_HTML, true);
    expect(result).toContain(SIGNATURE_HTML);
  });
});

describe('withSignature', () => {
  it('appends the signature after processing (the caller passes the processed body)', () => {
    const processed = '<html><body><p>Hi</p></body></html>';
    const result = withSignature(processed, true, SIGNATURE_HTML);
    expect(result).toContain('<!-- teros-signature -->');
    expect(result).toContain(SIGNATURE_HTML);
  });

  it('is a no-op without a signature', () => {
    expect(withSignature('<p>Hi</p>', true, undefined)).toBe('<p>Hi</p>');
  });
});

describe('resolveSignatureHtml', () => {
  it('prefers the user secret over the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sig-'));
    try {
      writeFileSync(join(dir, 'email-signature.html'), '<p>file sig</p>');
      expect(resolveSignatureHtml('<p>secret sig</p>', dir)).toBe('<p>secret sig</p>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the email-signature.html file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sig-'));
    try {
      writeFileSync(join(dir, 'email-signature.html'), '<p>file sig</p>');
      expect(resolveSignatureHtml(undefined, dir)).toBe('<p>file sig</p>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when nothing is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sig-'));
    try {
      expect(resolveSignatureHtml(undefined, dir)).toBeUndefined();
      expect(resolveSignatureHtml('   ', dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sig-'));
    try {
      writeFileSync(join(dir, 'email-signature.html'), '   ');
      expect(resolveSignatureHtml(undefined, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signatureToPlainText', () => {
  it('reduces an HTML signature to readable text with alt text and links', () => {
    const text = signatureToPlainText(SIGNATURE_HTML);
    expect(text).toContain('Alex Doe');
    expect(text).toContain('Frontend Developer — FDE');
    expect(text).toContain('Acme'); // img alt
    expect(text).toContain('acme.example.com (https://acme.example.com)'); // link + href
    expect(text).not.toContain('<');
  });

  it('unescapes common entities', () => {
    expect(signatureToPlainText('A &amp; B &lt;C&gt;')).toBe('A & B <C>');
  });
});
