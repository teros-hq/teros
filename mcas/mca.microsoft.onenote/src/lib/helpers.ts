/**
 * OneNote addressing and content helpers.
 *
 * This file owns everything OneNote-shaped that is not an HTTP call: turning
 * arguments into safe Graph path fragments, crossing the markdown/HTML
 * boundary in both directions, and assembling the multipart envelope page
 * creation requires. Tool files contain none of this logic.
 */

import { randomBytes } from 'node:crypto'
import { renderMarkdown } from '@teros/shared/markdown'
import TurndownService from 'turndown'
import type { GraphRequestOptions } from './graph-client'

/**
 * `$expand` values that make the parent fields the formatters read present in
 * the response. They live beside the formatters deliberately: a formatter and
 * the query that feeds it must not drift apart in separate edits.
 *
 * This app does not use `$select` on OneNote collections — its OData surface
 * is narrower than the drive API's and `$select` over navigation properties is
 * not dependable across personal and work accounts.
 */
export const PAGE_EXPAND = 'parentSection'
export const SECTION_EXPAND = 'parentNotebook'
export const SECTION_GROUP_EXPAND = 'parentNotebook'

/** Doubles apostrophes so a value is safe inside a quoted OData literal. */
export function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/** Escapes text destined for HTML markup. Never applied to generated markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A resolved identifier. `id` is the literal value, for echoing back in a tool
 * result; `encoded` is percent-encoded and is the only form safe to
 * interpolate into a Graph path.
 */
export interface IdRef {
  readonly id: string
  readonly encoded: string
}

function toRef(id: string): IdRef {
  const trimmed = id.trim()
  return { id: trimmed, encoded: encodeURIComponent(trimmed) }
}

/**
 * Resolves the first non-empty string among `names`, or throws.
 *
 * Nothing validates arguments before a handler runs — JSON Schema `required`
 * is advisory in this stack — so a typo'd argument name reaches the handler as
 * `undefined` and would otherwise interpolate the literal string "undefined"
 * into a Graph path.
 */
export function requireId(a: Record<string, unknown>, names: string[], label: string): IdRef {
  const found = optionalId(a, names)
  if (found) return found
  throw new Error(`Specify ${names.join(' or ')} — ${label}.`)
}

/** Like `requireId`, but returns undefined instead of throwing. */
export function optionalId(a: Record<string, unknown>, names: string[]): IdRef | undefined {
  for (const name of names) {
    const value = a[name]
    if (typeof value === 'string' && value.trim() !== '') return toRef(value)
  }
  return undefined
}

/**
 * Characters OneNote rejects in a notebook or section display name, plus the
 * 50-character ceiling. Validating here turns an opaque Graph error code into
 * a message that names the offending character.
 */
const INVALID_NAME_CHARS = /[?*\\/:<>|'"#]/
const MAX_NAME_LENGTH = 50

export function assertDisplayName(name: unknown, label: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`Specify ${label} — a non-empty name.`)
  }
  const trimmed = name.trim()
  const bad = trimmed.match(INVALID_NAME_CHARS)
  if (bad) {
    throw new Error(
      `OneNote does not allow "${bad[0]}" in a ${label}. Disallowed characters: ? * \\ / : < > | ' " #`,
    )
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`A ${label} must be ${MAX_NAME_LENGTH} characters or fewer.`)
  }
  return trimmed
}

/**
 * Converts caller content to an HTML fragment.
 *
 * `format` is explicit rather than sniffed: a heuristic that guesses wrong
 * either escapes a caller's markup into visible text or renders their prose
 * as markup. Callers say which they have.
 */
export async function markdownToHtmlFragment(
  content: string,
  format: 'markdown' | 'html' = 'markdown',
): Promise<string> {
  if (format === 'html') return content
  // Platform markdown policy (@teros/shared/markdown): `~` literal (MD-STRIKE-1), raw HTML stripped.
  return renderMarkdown(content)
}

/**
 * Wraps a body fragment in the HTML document OneNote expects.
 *
 * A OneNote page has no title field: its title is the `<title>` element of
 * this document. The title is user text and is escaped; the body is generated
 * markup and is not.
 */
export function buildPageHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>${escapeHtml(title)}</title>
  </head>
  <body>${bodyHtml}</body>
</html>`
}

/**
 * Converts OneNote page HTML to markdown so an agent can reason about it.
 *
 * OneNote returns absolutely-positioned `<div>` wrappers around every element;
 * turndown drops the wrappers and keeps the content.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim()
}

function defaultBoundary(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Builds the `multipart/form-data` body OneNote page creation requires.
 *
 * Four things must all be right or the request is silently malformed: the part
 * is named `Presentation` (case-sensitive), its content type is `text/html`,
 * the envelope uses CRLF line endings, and the returned content type — with
 * its boundary — reaches fetch instead of the client's JSON default.
 *
 * `generateBoundary` is injectable so the collision retry below is testable.
 * A boundary that appears inside the content truncates the part.
 */
export function buildMultipartPage(
  html: string,
  generateBoundary: () => string = defaultBoundary,
): { body: Buffer; contentType: string } {
  let boundary = generateBoundary()
  while (html.includes(boundary)) {
    boundary = generateBoundary()
  }

  const envelope =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="Presentation"\r\n` +
    `Content-Type: text/html\r\n` +
    `\r\n` +
    `${html}\r\n` +
    `--${boundary}--\r\n`

  return {
    body: Buffer.from(envelope, 'utf-8'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

// ---------------------------------------------------------------------------
// Response formatters
//
// Each reads its parent with a fallback and never branches on a field that may
// be absent, so a response fetched without the matching $expand degrades to a
// visible null rather than a crash or a wrong decision.
// ---------------------------------------------------------------------------

function webUrlOf(entity: any): string | null {
  return entity?.links?.oneNoteWebUrl?.href ?? null
}

export function formatNotebook(n: any): Record<string, unknown> {
  return {
    id: n?.id ?? null,
    displayName: n?.displayName ?? null,
    isDefault: n?.isDefault ?? null,
    isShared: n?.isShared ?? null,
    createdDateTime: n?.createdDateTime ?? null,
    lastModifiedDateTime: n?.lastModifiedDateTime ?? null,
    webUrl: webUrlOf(n),
  }
}

export function formatSection(s: any): Record<string, unknown> {
  return {
    id: s?.id ?? null,
    displayName: s?.displayName ?? null,
    isDefault: s?.isDefault ?? null,
    createdDateTime: s?.createdDateTime ?? null,
    lastModifiedDateTime: s?.lastModifiedDateTime ?? null,
    notebookId: s?.parentNotebook?.id ?? null,
    notebookName: s?.parentNotebook?.displayName ?? null,
  }
}

export function formatSectionGroup(g: any): Record<string, unknown> {
  return {
    id: g?.id ?? null,
    displayName: g?.displayName ?? null,
    createdDateTime: g?.createdDateTime ?? null,
    lastModifiedDateTime: g?.lastModifiedDateTime ?? null,
    notebookId: g?.parentNotebook?.id ?? null,
    notebookName: g?.parentNotebook?.displayName ?? null,
  }
}

export function formatPage(p: any): Record<string, unknown> {
  return {
    id: p?.id ?? null,
    title: p?.title ?? null,
    createdDateTime: p?.createdDateTime ?? null,
    lastModifiedDateTime: p?.lastModifiedDateTime ?? null,
    level: p?.level ?? null,
    order: p?.order ?? null,
    webUrl: webUrlOf(p),
    sectionId: p?.parentSection?.id ?? null,
    sectionName: p?.parentSection?.displayName ?? null,
  }
}

/**
 * The client's request function, as helpers see it. Declared here so
 * `pollOperation` can be given the caller's `graphRequest` without helpers.ts
 * importing the client and building requests of its own.
 */
export type GraphRequestFn = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: GraphRequestOptions,
) => Promise<T>

export interface OneNoteOperation {
  id?: string
  status?: string
  resourceLocation?: string
  error?: { code?: string; message?: string }
}

/** Total time to wait for a long-running operation before giving up. */
const MAX_POLL_MS = 60_000

/**
 * Delay before the next poll: 250 ms, doubling to a 2 s ceiling.
 *
 * Short at the start because a small page usually copies before the first
 * poll returns, and a 1 s fixed interval would spend most of a typical copy
 * asleep.
 */
function pollDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2000)
}

/**
 * Polls a OneNote long-running operation to a terminal state.
 *
 * Bounded per spec §8.5. Throws on `Failed`, and on exhausting the budget —
 * silently returning a non-terminal status would let a caller report success
 * for a copy that never happened.
 */
export async function pollOperation(
  graphRequest: GraphRequestFn,
  operationUrl: string,
): Promise<OneNoteOperation> {
  const deadline = Date.now() + MAX_POLL_MS

  for (let attempt = 0; ; attempt++) {
    const operation = await graphRequest<OneNoteOperation>('GET', operationUrl)
    const status = operation.status ?? 'Unknown'

    if (status === 'Completed') return operation
    if (status === 'Failed') {
      const detail = operation.error?.message ?? operation.error?.code ?? 'no reason given'
      throw new Error(`OneNote operation failed: ${detail}`)
    }

    const delay = pollDelayMs(attempt)
    if (Date.now() + delay >= deadline) {
      throw new Error(
        `OneNote operation did not finish within ${MAX_POLL_MS / 1000}s (last status: ${status}).`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
