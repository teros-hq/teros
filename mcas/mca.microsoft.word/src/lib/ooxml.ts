/**
 * The archive layer.
 *
 * A .docx is a zip of XML parts. This module opens one, lets a caller edit only
 * the parts it names, and re-zips it with every other entry preserved. That
 * fidelity guarantee (spec §7.1) is what makes the app safe on documents it did
 * not author: `docx` and `mammoth` are generators and readers, not editors, and
 * re-serializing a real document through them discards styles, headers,
 * images, comments, and tracked changes (spec §2.1).
 *
 * This module builds no HTTP requests. `editDocxInPlace` receives the caller's
 * `graphRequest` so the whole download-modify-validate-upload cycle can live in
 * one place without helpers depending on the client.
 */

import JSZip from 'jszip';
import type { GraphRequestOptions } from './graph-client';
import { itemAction } from './helpers';

/** Spec §8.4: refuse rather than exhaust memory. */
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Parts without which Word will not open the document. */
const REQUIRED_PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** A legacy binary .doc is an OLE2 compound file, not a zip at all. */
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Every `<w:t>` in a fragment, with its text and where that text sits.
 *
 * Shared by the readers and by `replace-text`: both need "the visible text of
 * this XML, and which element each character came from", and two
 * implementations of that would drift.
 */
export interface TextNode {
  /** Offset of the text content inside the fragment, not of the element. */
  start: number;
  end: number;
  text: string;
}

const T_ELEMENT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/**
 * Decodes the five predefined XML entities, plus numeric character references.
 *
 * A `<w:t>` can carry `&#233;` or `&#xE9;` for a character the author's tool
 * chose not to write literally. Leaving those alone means the literal string
 * `&#233;` is what `replaceInParagraph` sees as "the text", and when it
 * re-escapes the untouched runs on write-back the leading `&` becomes
 * `&amp;#233;` — turning `é` into visible text in every paragraph the replace
 * touched, not just the matched run.
 */
export function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&amp;/g, '&');
}

/**
 * The XML 1.0 §2.2 forbidden character range: control codes other than tab,
 * LF, CR. These control characters are the point of this pattern, not a
 * mistake — that is exactly what `noControlCharactersInRegex` cannot tell
 * apart, and `useRegexLiterals` auto-fixes any `RegExp`-constructor
 * workaround straight back to this literal.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 §2.2 forbidden control codes are the intended match target, not an accidental literal.
const FORBIDDEN_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function escapeXmlText(value: string): string {
  // XML 1.0 §2.2 forbids these outright — they cannot appear literally or as a
  // character reference, so stripping is the only option. Form feed (\x0C) in
  // particular is a routine page separator in text extracted from PDFs, which
  // is exactly the kind of text an agent pipes into append-paragraphs. Left
  // in, the document is not well-formed and Word cannot open it. Stripping is
  // safe on the replaceInParagraph re-escape path too: valid XML could never
  // have contained these bytes to begin with.
  return value
    .replace(FORBIDDEN_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function textNodes(fragmentXml: string): TextNode[] {
  const nodes: TextNode[] = [];
  T_ELEMENT.lastIndex = 0;
  let match: RegExpExecArray | null = T_ELEMENT.exec(fragmentXml);
  while (match !== null) {
    const start = match.index + match[0].length - match[1].length - '</w:t>'.length;
    nodes.push({ start, end: start + match[1].length, text: unescapeXmlText(match[1]) });
    match = T_ELEMENT.exec(fragmentXml);
  }
  return nodes;
}

/**
 * Rejects bytes that are not a usable .docx, before anything tries to open them.
 *
 * Checked by content rather than by name: a file named `.docx` whose bytes are
 * OLE2 is exactly the case an extension check misses, and `JSZip.loadAsync` on
 * one throws something an agent cannot act on.
 */
export function assertUsableDocx(bytes: Buffer): void {
  if (bytes.length > MAX_DOCX_BYTES) {
    throw new Error(
      `This document is ${Math.round(bytes.length / 1024 / 1024)} MB, above the 50 MB limit these tools can hold in memory.`,
    );
  }
  if (bytes.subarray(0, 8).equals(OLE2_MAGIC)) {
    throw new Error(
      'This is a legacy binary .doc file, not a .docx. Convert it to .docx in Word before editing it here.',
    );
  }
  if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new Error('This file is not a .docx archive — its contents are not a zip.');
  }
}

/** Opens the archive, turning a zip failure into something actionable. */
export async function openDocx(bytes: Buffer): Promise<JSZip> {
  assertUsableDocx(bytes);
  try {
    return await JSZip.loadAsync(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This .docx could not be opened — it may be corrupt or password-protected (${detail}).`,
    );
  }
}

export async function readPart(zip: JSZip, name: string): Promise<string> {
  const part = zip.file(name);
  if (!part) throw new Error(`This document has no ${name} part.`);
  return await part.async('string');
}

/**
 * Replaces one part's contents.
 *
 * `createFolders: false` is load-bearing, not tidiness. The default adds a
 * directory entry for each parent path segment, so writing `word/document.xml`
 * turns a 7-entry archive into an 8-entry one carrying a `word/` entry the
 * original never had — measured. Word tolerates it, and a fidelity test that
 * walks the original entry list and compares each one would never notice, which
 * is exactly why it would have shipped.
 */
export function writePart(zip: JSZip, name: string, content: string): void {
  zip.file(name, content, { createFolders: false });
}

export async function packDocx(zip: JSZip): Promise<Buffer> {
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Confirms a re-zipped buffer is still a document Word can open (spec §8.3).
 *
 * Read-modify-write fails safe in one direction — a failed upload leaves the
 * original intact — and silently in the other: a successfully uploaded,
 * subtly corrupted file. This is the cheap check that catches the second.
 */
export async function validateDocx(bytes: Buffer): Promise<void> {
  const zip = await openDocx(bytes);
  for (const name of REQUIRED_PARTS) {
    if (!zip.file(name)) {
      throw new Error(`The rebuilt document is missing ${name}; refusing to upload it.`);
    }
  }
  const doc = await readPart(zip, 'word/document.xml');
  // XML 1.0 §2.2 forbids these code points outright — not even as a character
  // reference — so a document.xml containing one is not well-formed no matter
  // how balanced its tags are. `escapeXmlText` is the funnel for every
  // caller-supplied string, but this catches a future writer that bypasses it.
  const forbidden = doc.match(FORBIDDEN_XML_CHARS);
  if (forbidden) {
    const codePoint = forbidden[0].codePointAt(0) ?? 0;
    throw new Error(
      `The rebuilt document.xml contains U+${codePoint.toString(16).padStart(4, '0').toUpperCase()}, ` +
        'a control character XML 1.0 forbids outright; refusing to upload it.',
    );
  }
  // A full parse would be heavier than this needs to be. What actually breaks
  // Word is an unbalanced body, and that is cheap to detect.
  if (!doc.includes('<w:body') || !doc.includes('</w:body>')) {
    throw new Error('The rebuilt document.xml does not parse: its <w:body> is malformed.');
  }
  const opens = (doc.match(/<w:p\b(?:[^>]*[^/>])?>/g) || []).length;
  const closes = (doc.match(/<\/w:p>/g) || []).length;
  if (opens !== closes) {
    throw new Error(
      `The rebuilt document.xml does not parse: ${opens} paragraph opens against ${closes} closes.`,
    );
  }
}

/**
 * Byte ranges of the top-level `<w:p>` elements in `document.xml`.
 *
 * Depth-aware rather than a regex, because `<w:p>` nests: a paragraph
 * containing a text box holds further paragraphs inside `<w:txbxContent>`. The
 * obvious non-greedy pattern stops at the inner closing tag and truncates the
 * outer paragraph — measured, it silently loses the text after the text box,
 * which would make `list-paragraphs` report the wrong content and every edit
 * tool target the wrong span.
 *
 * Self-closing `<w:p/>` counts as a paragraph: an empty paragraph is visible in
 * Word, and skipping it would shift every later index (spec §7.6).
 */
export function paragraphRanges(documentXml: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // `<w:tbl>` is tracked as well as `<w:p>`, because a table cell's content is
  // a `<w:p>` that is NOT nested inside another `<w:p>` — so paragraph-depth
  // alone sees it at the top level. Without this, an ordinary document with a
  // two-cell table reports its cells as paragraphs 1 and 2, and every index an
  // agent was given points at the wrong content: `delete-paragraph` empties a
  // table cell, which is invalid OOXML, and `replace-text`'s `paragraphIndex`
  // edits a cell instead of the prose. Measured on exactly that shape.
  //
  // Table content is therefore not addressable by paragraph index at all,
  // which matches spec §2.1's bounded edit surface: the tools offer what is
  // safe to do in XML, and rewriting arbitrary table structure is not on the
  // list. `read-document` still returns table text, through mammoth.
  const tag = /<w:tbl\b[^>]*?\/>|<w:tbl\b[^>]*>|<\/w:tbl>|<w:p\b[^>]*?\/>|<w:p\b[^>]*>|<\/w:p>/g;
  let tableDepth = 0;
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null = tag.exec(documentXml);

  while (match !== null) {
    const tagText = match[0];

    // Table boundaries first: everything between them is out of scope.
    if (tagText.startsWith('<w:tbl')) {
      if (!tagText.endsWith('/>')) tableDepth += 1;
      match = tag.exec(documentXml);
      continue;
    }
    if (tagText === '</w:tbl>') {
      tableDepth -= 1;
      match = tag.exec(documentXml);
      continue;
    }
    if (tableDepth > 0) {
      match = tag.exec(documentXml);
      continue;
    }

    if (tagText.endsWith('/>')) {
      if (depth === 0) ranges.push({ start: match.index, end: tag.lastIndex });
      match = tag.exec(documentXml);
      continue;
    }
    if (tagText === '</w:p>') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        ranges.push({ start, end: tag.lastIndex });
        start = -1;
      }
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
    match = tag.exec(documentXml);
  }
  return ranges;
}

/** The client's request function, as this module sees it. */
export type GraphRequestFn = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: GraphRequestOptions,
) => Promise<T>;

/**
 * The whole read-modify-write cycle, in one place.
 *
 * Download, open, hand the archive to `mutate`, re-zip, validate, upload.
 * Every edit tool goes through here, so the riskiest sequence in the app is
 * written once rather than eight times. Nothing is uploaded if validation
 * fails — the stored document is left exactly as it was.
 */
export async function editDocxInPlace(
  graphRequest: GraphRequestFn,
  ref: string,
  mutate: (zip: JSZip) => Promise<void> | void,
): Promise<{ uploadedBytes: number }> {
  const contentUrl = itemAction(ref, '/content');
  const original = await graphRequest<Buffer>('GET', contentUrl, undefined, {
    responseType: 'buffer',
  });
  const zip = await openDocx(Buffer.from(original));

  await mutate(zip);

  const rebuilt = await packDocx(zip);
  await validateDocx(rebuilt);

  await graphRequest('PUT', contentUrl, undefined, {
    rawBody: rebuilt,
    headers: { 'Content-Type': DOCX_CONTENT_TYPE },
  });

  return { uploadedBytes: rebuilt.length };
}

/*
 * `textNodes`, `escapeXmlText`, and `unescapeXmlText` already live in this file
 * from Task 3 — the readers need them too, and two implementations of "the
 * visible text of this XML" would drift apart. Do not redefine them here.
 */

/**
 * Replaces text inside one paragraph, across run boundaries.
 *
 * OOXML splits visible text across runs for reasons that have nothing to do
 * with meaning — spell-check state, formatting, tracked revisions — so the
 * match is found in the reconstructed visible text and then written back into
 * whichever runs it turned out to span (spec §7.3).
 *
 * The walk below replaced an earlier version that tracked per-node edits and
 * spliced them. That version was wrong: two matches inside one run left only
 * the last replacement, silently deleting the first match's text. Emitting
 * character by character into the owning node's buffer handles any number of
 * matches, in any arrangement across runs, without special cases.
 */
export function replaceInParagraph(
  paragraphXml: string,
  search: string,
  replacement: string,
): { xml: string; count: number } {
  if (search === '') return { xml: paragraphXml, count: 0 };

  const nodes = textNodes(paragraphXml);
  if (nodes.length === 0) return { xml: paragraphXml, count: 0 };

  // Reconstructed visible text, plus which node owns each character.
  let visible = '';
  const owner: TextNode[] = [];
  for (const node of nodes) {
    for (let i = 0; i < node.text.length; i++) owner.push(node);
    visible += node.text;
  }
  if (!visible.includes(search)) return { xml: paragraphXml, count: 0 };

  const buffers = new Map<TextNode, string>(nodes.map((node) => [node, '']));
  let count = 0;
  let i = 0;
  while (i < visible.length) {
    if (visible.startsWith(search, i)) {
      // The replacement lands in the run owning the match's first character;
      // the rest of the match simply is not emitted anywhere.
      buffers.set(owner[i], `${buffers.get(owner[i])}${replacement}`);
      i += search.length;
      count += 1;
    } else {
      buffers.set(owner[i], `${buffers.get(owner[i])}${visible[i]}`);
      i += 1;
    }
  }

  // Splice back last-to-first so earlier offsets stay valid.
  let xml = paragraphXml;
  for (let n = nodes.length - 1; n >= 0; n--) {
    const node = nodes[n];
    xml =
      xml.slice(0, node.start) + escapeXmlText(buffers.get(node) as string) + xml.slice(node.end);
  }
  return { xml, count };
}

/**
 * Applies `replaceInParagraph` across the document, optionally scoped to one
 * paragraph index. Paragraphs are rewritten last-to-first so that each
 * paragraph's recorded range stays valid while earlier ones are still pending.
 */
export function replaceTextInDocument(
  documentXml: string,
  search: string,
  replacement: string,
  paragraphIndex?: number,
): { xml: string; count: number } {
  const ranges = paragraphRanges(documentXml);
  if (paragraphIndex !== undefined && (paragraphIndex < 0 || paragraphIndex >= ranges.length)) {
    throw new Error(
      `This document has ${ranges.length} paragraphs, so index ${paragraphIndex} does not exist. Call list-paragraphs for the current indices.`,
    );
  }

  let xml = documentXml;
  let count = 0;
  for (let index = ranges.length - 1; index >= 0; index--) {
    if (paragraphIndex !== undefined && index !== paragraphIndex) continue;
    const range = ranges[index];
    const result = replaceInParagraph(xml.slice(range.start, range.end), search, replacement);
    if (result.count === 0) continue;
    count += result.count;
    xml = xml.slice(0, range.start) + result.xml + xml.slice(range.end);
  }
  return { xml, count };
}

/**
 * Where new body content must go.
 *
 * `<w:sectPr>` holds the section's page setup and OOXML requires it to be the
 * last child of `<w:body>`. Splicing new paragraphs in before `</w:body>` would
 * put them after it and produce an invalid document — the kind of breakage that
 * surfaces in Word on a user's machine rather than in any test here.
 *
 * Every per-section `<w:sectPr>` other than the body-level one lives inside a
 * `<w:pPr>` (a paragraph carrying a section break) or inside a
 * `<w:sectPrChange>` (Word's tracked-change copy of the previous section
 * properties, itself nested in the body-level `<w:sectPr>`). Both are
 * excluded explicitly: `<w:pPr>` depth is tracked the same way `paragraphRanges`
 * tracks `<w:tbl>` depth — while inside one, no `<w:sectPr>` seen can be the
 * body-level element, however deeply `<w:sectPr>` itself is nested inside it —
 * and `<w:sectPrChange>` is excluded because it is not `<w:pPr>`-nested but a
 * genuine, further-nested `<w:sectPr>` sibling structure, so it needs its own
 * depth counter. Anchoring the match some other way is not enough: the nested
 * element in `<w:sectPrChange>` is a real `<w:sectPr>`, so it survives any
 * pattern that only excludes `<w:sectPrChange` textually. What identifies the
 * body-level one is that it is the last `<w:sectPr>` seen at both depths zero.
 *
 * (`\b` is what excludes `<w:sectPrChange`: there is no word boundary
 * between `r` and `C`.)
 */
export function bodyInsertionPoint(documentXml: string): number {
  // Four-alternative shape: `<w:pPr>` open/close bracket the paragraph
  // properties that every per-section `<w:sectPr>` other than the body-level
  // one lives inside; `<w:sectPr>` open/close (folding the self-closing form
  // into the opener, exactly as `paragraphRanges` folds `<w:p/>`) track
  // sectPrChange nesting. A self-closing `<w:pPr/>` — an empty one — must not
  // move the depth counter either, for the same reason a self-closing
  // `<w:sectPr/>` must not: there is nothing later to close it, so treating it
  // as an opener leaves the counter permanently off by one and no later
  // `<w:sectPr>` is ever recorded as body-level again.
  const tag =
    /<w:pPr\b[^>]*?\/>|<w:pPr\b[^>]*>|<\/w:pPr>|<w:sectPr\b[^>]*?\/>|<w:sectPr\b[^>]*>|<\/w:sectPr>/g;
  let pPrDepth = 0;
  let sectPrDepth = 0;
  let bodyLevel = -1;
  let match: RegExpExecArray | null = tag.exec(documentXml);
  while (match !== null) {
    const tagText = match[0];

    if (tagText.startsWith('<w:pPr')) {
      if (!tagText.endsWith('/>')) pPrDepth += 1;
      match = tag.exec(documentXml);
      continue;
    }
    if (tagText === '</w:pPr>') {
      pPrDepth -= 1;
      match = tag.exec(documentXml);
      continue;
    }
    if (pPrDepth > 0) {
      // Inside paragraph properties: whatever `<w:sectPr>` nesting looks like
      // in here, it cannot be the body-level section properties.
      match = tag.exec(documentXml);
      continue;
    }

    if (tagText.endsWith('/>')) {
      // A whole section in one tag: it can be the body-level one, but there is
      // nothing to close, so the depth must not move.
      if (sectPrDepth === 0) bodyLevel = match.index;
    } else if (tagText === '</w:sectPr>') {
      sectPrDepth -= 1;
    } else {
      if (sectPrDepth === 0) bodyLevel = match.index;
      sectPrDepth += 1;
    }
    match = tag.exec(documentXml);
  }
  if (bodyLevel !== -1) return bodyLevel;

  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) throw new Error('This document.xml has no <w:body> to insert into.');
  return bodyEnd;
}

const HEADING_STYLES = new Set(['Heading1', 'Heading2', 'Heading3']);

/** One `<w:p>` element carrying escaped literal text. */
export function buildParagraphXml(text: string, style?: string): string {
  const properties =
    style && HEADING_STYLES.has(style) ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  // The caller's text is data. Escaping it is what stops "<b>bold</b>" in a
  // user's prose from becoming markup inside the document.
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`;
}

export function insertParagraphsXml(documentXml: string, paragraphsXml: string): string {
  const at = bodyInsertionPoint(documentXml);
  return documentXml.slice(0, at) + paragraphsXml + documentXml.slice(at);
}

export function removeParagraph(documentXml: string, index: number): string {
  const ranges = paragraphRanges(documentXml);
  if (index < 0 || index >= ranges.length) {
    throw new Error(
      `This document has ${ranges.length} paragraphs, so index ${index} does not exist. Call list-paragraphs for the current indices.`,
    );
  }
  const range = ranges[index];
  return documentXml.slice(0, range.start) + documentXml.slice(range.end);
}

/**
 * A `<w:tbl>` with a plain single-line border grid.
 *
 * Cell text is escaped: a table is populated from data an agent gathered, and
 * an ampersand in a company name must not become markup.
 */
export function buildTableXml(rows: string[][], headerRow = false): string {
  const columns = rows[0].length;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
    .join('');
  const grid = `<w:tblGrid>${'<w:gridCol w:w="2400"/>'.repeat(columns)}</w:tblGrid>`;

  const body = rows
    .map((cells, rowIndex) => {
      const bold = headerRow && rowIndex === 0 ? '<w:rPr><w:b/></w:rPr>' : '';
      const tc = cells
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r>${bold}<w:t xml:space="preserve">${escapeXmlText(cell)}</w:t></w:r></w:p></w:tc>`,
        )
        .join('');
      return `<w:tr>${tc}</w:tr>`;
    })
    .join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${grid}${body}</w:tbl><w:p/>`;
}

/** A paragraph whose only content is a page break. */
export function buildPageBreakXml(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * PNG or JPEG, decided by content — a filename proves nothing.
 *
 * Returns the suffixes the format may legitimately carry, because OPC resolves
 * a part's content type from the literal extension of its own path. JPEG is
 * conventionally `.jpg` more often than `.jpeg`, and declaring the wrong one
 * leaves the part with no resolvable content type.
 */
export function imageContentType(bytes: Buffer): { mime: string; suffixes: string[] } {
  if (bytes.subarray(0, 4).equals(PNG_MAGIC)) return { mime: 'image/png', suffixes: ['png'] };
  if (bytes.subarray(0, 3).equals(JPEG_MAGIC)) {
    return { mime: 'image/jpeg', suffixes: ['jpg', 'jpeg'] };
  }
  throw new Error('Images must be PNG or JPEG. These bytes are neither.');
}

/**
 * The next free drawing id in `document.xml`.
 *
 * `wp:docPr` and `pic:cNvPr` ids must be unique across the document. Hardcoding
 * one means a second `insert-image` call emits a duplicate, which Word treats
 * as damage and offers to repair. Measured: two inserts produced four elements
 * all claiming `id="1"`.
 */
export function nextDrawingId(documentXml: string): number {
  const ids = [...documentXml.matchAll(/<(?:wp:docPr|pic:cNvPr)\b[^>]*\bid="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

/**
 * Adds a media part and its relationship, returning the fresh relationship id.
 *
 * The id is derived from the highest `rId<N>` already present. A hardcoded or
 * count-derived id collides as soon as the document has relationships of its
 * own — and every real document does.
 */
export async function addImagePart(
  zip: JSZip,
  fileName: string,
  bytes: Buffer,
): Promise<{ relationshipId: string; partName: string }> {
  const { mime, suffixes } = imageContentType(bytes);

  // OPC resolves a part's content type from the literal extension of its own
  // path, so the `<Default>` must declare the suffix the file actually carries
  // — not the canonical format name. Measured: a JPEG stored as `chart.jpg`
  // with only `Extension="jpeg"` declared has no resolvable content type, and
  // Word reports the document as needing repair.
  const suffix = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!suffixes.includes(suffix)) {
    throw new Error(
      `fileName "${fileName}" must end in .${suffixes.join(' or .')} to match the image's actual format.`,
    );
  }

  const relsName = 'word/_rels/document.xml.rels';
  const rels = await readPart(zip, relsName);
  const highest = [...rels.matchAll(/Id="rId(\d+)"/g)].reduce(
    (max, match) => Math.max(max, Number(match[1])),
    0,
  );
  const relationshipId = `rId${highest + 1}`;

  const partName = `word/media/${fileName}`;
  // Word names its own media parts image1.png, image2.png, … so an agent's
  // "natural" fileName choice can collide with one already in the document.
  // Writing over it would silently destroy a media part the caller never
  // targeted, everywhere it appears in the document — a direct breach of the
  // fidelity guarantee (spec §7.1). Refuse instead of silently de-duplicating,
  // so the caller learns and can choose a different name.
  if (zip.file(partName)) {
    throw new Error(
      `This document already has a media part named "${fileName}". Choose a different fileName — overwriting it would destroy the existing image.`,
    );
  }
  zip.file(partName, bytes, { createFolders: false });

  const relationship = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`;
  writePart(zip, relsName, rels.replace('</Relationships>', `${relationship}</Relationships>`));

  const typesName = '[Content_Types].xml';
  const types = await readPart(zip, typesName);
  if (!types.includes(`Extension="${suffix}"`)) {
    const declared = types.replace(
      '<Default',
      `<Default Extension="${suffix}" ContentType="${mime}"/><Default`,
    );
    // A first-occurrence replace that matched nothing would silently leave the
    // new part undeclared, which is the same corruption by a quieter route.
    if (declared === types) {
      throw new Error("This document's [Content_Types].xml has no <Default> entry to extend.");
    }
    writePart(zip, typesName, declared);
  }

  return { relationshipId, partName };
}

/** The `<w:drawing>` run that renders an embedded image inline. */
export function buildImageParagraphXml(
  relationshipId: string,
  widthEmu: number,
  heightEmu: number,
  drawingId: number,
): string {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${drawingId}" name="Picture ${drawingId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="Picture ${drawingId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * Sets one `docProps/core.xml` element, adding it if absent.
 *
 * The value is escaped: a title like "R&D <2026>" is text, and unescaped it
 * would produce a core.xml that no longer parses.
 */
export function setCoreProperty(coreXml: string, tag: string, value: string): string {
  const replacement = `<${tag}>${escapeXmlText(value)}</${tag}>`;

  // Self-closing form FIRST. Word writes an unset property as `<dc:title/>`,
  // and a pattern that assumes a closing tag mishandles it twice over:
  // it fails to match (so the property is appended as a duplicate), and then
  // on a second call — which `idempotentHint: true` promises is safe — it
  // matches from the leftover `<dc:title/>` lazily to the duplicate's closing
  // tag, swallowing every sibling property in between. Measured: two calls
  // deleted `<dc:creator>Bob</dc:creator>` outright and produced
  // `<dc:title/>New Title</dc:title>`, which is not well-formed, and uploaded
  // it with `success: true`.
  const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`);
  if (selfClosing.test(coreXml)) return coreXml.replace(selfClosing, replacement);

  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`);
  if (paired.test(coreXml)) return coreXml.replace(paired, replacement);

  // Nothing to replace: append. Fail loudly rather than returning an unchanged
  // document with `success: true` if there is no root element to append into.
  const closing = '</cp:coreProperties>';
  if (!coreXml.includes(closing)) {
    throw new Error(
      "This document's docProps/core.xml has no </cp:coreProperties> to append a property to.",
    );
  }
  return coreXml.replace(closing, `${replacement}${closing}`);
}
