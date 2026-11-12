import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Email signature resolution and insertion.
 *
 * Standard (applies to both Gmail and Outlook MCAs):
 * 1. Provider-native signature when the API exposes it (Gmail sendAs.signature).
 * 2. SIGNATURE_HTML stored in user secrets (per-account, via set-signature).
 * 3. email-signature.html file in the MCA working directory (shared fallback).
 * 4. No signature — never invent one.
 *
 * The signature is ALWAYS appended AFTER body processing (Markdown → HTML
 * conversion), so it never passes through marked.parse and its structure
 * (tables, inline styles, logos, GIFs) is preserved verbatim.
 */

export const SIGNATURE_SECRET_KEY = 'SIGNATURE_HTML';
export const SIGNATURE_FILE = 'email-signature.html';

/** Marker used to detect an already-inserted signature (dedupe). */
const SIGNATURE_MARKER = '<!-- teros-signature -->';

/** Minimal HTML tag sniffing — a body that looks like HTML must never be sent as text/plain. */
const HTML_SNIFF_RE = /<\s*(html|body|div|table|img|p|br|span|h[1-6]|ul|ol|li|a\b|strong|em|blockquote|hr)\b/i;

/** True when the string looks like HTML markup (not plain text / Markdown). */
export function looksLikeHtml(text: string): boolean {
  return HTML_SNIFF_RE.test(text);
}

/**
 * Resolve the signature HTML for the account, cascading through:
 * user secrets → workspace file. Returns undefined when none is configured.
 * (The provider-native lookup — Gmail sendAs — happens in the caller, which
 * already has the authenticated client.)
 */
export function resolveSignatureHtml(
  secretsSignature: string | undefined,
  workingDir: string = process.cwd(),
): string | undefined {
  const trimmedSecret = secretsSignature?.trim();
  if (trimmedSecret) return trimmedSecret;

  const filePath = join(workingDir, SIGNATURE_FILE);
  if (existsSync(filePath)) {
    const fileContent = readFileSync(filePath, 'utf-8').trim();
    if (fileContent) return fileContent;
  }

  return undefined;
}

/**
 * Append the signature after the processed body.
 * - Signature is wrapped with a marker comment for dedupe on update-draft.
 * - If the body is HTML, the signature is inserted before </body> when
 *   present, otherwise appended at the end.
 * - If the body is plain text, the signature is appended after a blank line
 *   (the signature itself must be HTML-safe: callers should only append a
 *   text-representable signature in that case — see signatureToPlainText).
 */
export function appendSignature(
  body: string,
  signature: string | undefined,
  isHtml: boolean,
): string {
  if (!signature || !signature.trim()) return body;

  // Dedupe: never insert the signature twice (update-draft / reply chains).
  if (body.includes(SIGNATURE_MARKER)) return body;

  if (isHtml) {
    const wrapped = `\n${SIGNATURE_MARKER}\n${signature.trim()}\n`;
    const closeBody = body.match(/<\/body\s*>/i);
    if (closeBody && closeBody.index !== undefined) {
      return body.slice(0, closeBody.index) + wrapped + body.slice(closeBody.index);
    }
    return body + wrapped;
  }

  // Plain-text body: append after a blank line, with the marker on its own line.
  return `${body.replace(/\s+$/, '')}\n\n${SIGNATURE_MARKER}\n${signature.trim()}`;
}

/**
 * Reduce a signature to plain text for plain-text bodies: strips tags,
 * keeps alt text of images (logos/GIFs) and link hrefs readable.
 */
export function signatureToPlainText(signature: string): string {
  return signature
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full pipeline helper: process → (optionally) append signature.
 * Signature insertion happens strictly AFTER body processing so the
 * Markdown converter never touches signature markup.
 */
export function withSignature(
  processedBody: string,
  isHtml: boolean,
  signature: string | undefined,
): string {
  if (!signature) return processedBody;
  return appendSignature(processedBody, signature, isHtml);
}

/**
 * Gmail: extract the account's native signature from
 * users.settings.sendAs (field `signature`, already HTML).
 * Returns undefined when absent or when the API call fails
 * (e.g. missing gmail.settings.basic scope — falls through the cascade).
 */
export async function fetchGmailSendAsSignature(
  gmail: any,
): Promise<string | undefined> {
  try {
    const response = await gmail.users.settings.sendAs.list({ userId: 'me' });
    const sendAs = (response.data?.sendAs || []).find(
      (s: any) => s.isPrimary === true,
    );
    const signature = sendAs?.signature?.trim();
    return signature || undefined;
  } catch {
    // 403 without gmail.settings.basic, or transient errors — cascade continues.
    return undefined;
  }
}
