/**
 * Text and structure extraction.
 *
 * Reading is the one direction where a library is safe: `mammoth` produces HTML
 * from a document without ever writing one back, so none of spec §2.1's
 * fidelity concerns apply here. Structural reads go through `paragraphRanges`
 * so that paragraph indices mean the same thing to every tool.
 */

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import {
  assertUsableDocx,
  openDocx,
  paragraphRanges,
  readPart,
  textNodes,
  unescapeXmlText,
} from './ooxml';

/**
 * The visible text of one paragraph.
 *
 * Concatenates every `<w:t>`, because OOXML routinely splits a single visible
 * word across runs — spell-check state, formatting boundaries, and tracked
 * revisions all fragment it (spec §7.3). Reading only the first element would
 * report "Hel" for a paragraph the user sees as "Hello world".
 */
export function paragraphText(paragraphXml: string): string {
  return textNodes(paragraphXml)
    .map((node) => node.text)
    .join('');
}

export function paragraphStyle(paragraphXml: string): string | null {
  const match = paragraphXml.match(/<w:pStyle\s+w:val="([^"]*)"/);
  return match ? match[1] : null;
}

/**
 * Every top-level paragraph with the index each edit tool targets.
 *
 * Shares `paragraphRanges` with the edit tools deliberately: if this disagreed
 * with them about what counts as a paragraph, an agent reading index 3 and
 * deleting index 3 would be talking about different text.
 */
export function listParagraphs(
  documentXml: string,
): Array<{ index: number; text: string; style: string | null; empty: boolean }> {
  return paragraphRanges(documentXml).map((range, index) => {
    const xml = documentXml.slice(range.start, range.end);
    const text = paragraphText(xml);
    return { index, text, style: paragraphStyle(xml), empty: text.trim() === '' };
  });
}

/**
 * Guarded the same way `openDocx` guards edits: a legacy .doc or an
 * oversized/corrupt file must fail with the same actionable message a caller
 * gets from the edit path, not with mammoth's raw "is this a zip file?" error.
 */
export async function docxToHtml(bytes: Buffer): Promise<string> {
  assertUsableDocx(bytes);
  const { value } = await mammoth.convertToHtml({ buffer: bytes });
  return value;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export async function docxToMarkdown(bytes: Buffer): Promise<string> {
  return turndown.turndown(await docxToHtml(bytes)).trim();
}

/** Reads `word/document.xml` out of a downloaded archive. */
export async function documentXmlOf(bytes: Buffer): Promise<string> {
  return await readPart(await openDocx(bytes), 'word/document.xml');
}

/** The core properties Word shows in File → Info. */
export async function coreProperties(bytes: Buffer): Promise<Record<string, string | null>> {
  const zip = await openDocx(bytes);
  const part = zip.file('docProps/core.xml');
  if (!part) return { title: null, creator: null, subject: null, description: null };
  const xml = await part.async('string');
  const read = (tag: string): string | null => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return match ? unescapeXmlText(match[1]) : null;
  };
  return {
    title: read('dc:title'),
    creator: read('dc:creator'),
    subject: read('dc:subject'),
    description: read('dc:description'),
  };
}

/**
 * Comments, if the document has any.
 *
 * `word/comments.xml` is an optional part — a document with no comments simply
 * does not have it, so its absence is an empty list rather than an error.
 * Comment text is split across runs like any other OOXML text, so it goes
 * through `paragraphText` rather than a single-element read.
 */
export async function readComments(
  bytes: Buffer,
): Promise<Array<{ id: string; author: string | null; date: string | null; text: string }>> {
  const zip = await openDocx(bytes);
  const part = zip.file('word/comments.xml');
  if (!part) return [];

  const xml = await part.async('string');
  const comments: Array<{ id: string; author: string | null; date: string | null; text: string }> =
    [];
  const pattern = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
  // `noAssignInExpressions` is an error under this repo's biome preset.
  let match: RegExpExecArray | null = pattern.exec(xml);
  while (match !== null) {
    const attributes = match[1];
    const read = (name: string): string | null =>
      attributes.match(new RegExp(`w:${name}="([^"]*)"`))?.[1] ?? null;
    // A comment body can hold several `<w:p>` elements. Handing the whole body
    // to `paragraphText` concatenates every `<w:t>` regardless of paragraph
    // boundaries — measured, a two-paragraph comment read back as
    // "First point.Second point.", run together and misleading to an agent.
    const body = match[2];
    const ranges = paragraphRanges(body);
    const text =
      ranges.length > 0
        ? ranges
            .map((range) => paragraphText(body.slice(range.start, range.end)))
            .join('\n')
            .trim()
        : paragraphText(body).trim();

    comments.push({
      id: read('id') ?? '',
      author: read('author'),
      date: read('date'),
      text,
    });
    match = pattern.exec(xml);
  }
  return comments;
}
