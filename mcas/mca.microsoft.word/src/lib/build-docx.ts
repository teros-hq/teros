/**
 * New-document synthesis.
 *
 * The `docx` library owns the whole file here, which is the only arrangement in
 * which it is safe to use: spec §2.1 rejects it as an editor because
 * re-serializing an existing document through any generator discards styles,
 * headers, images, comments, and tracked changes. Nothing outside
 * `create-document` may import this module.
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

export interface ParagraphContent {
  text: string;
  /** `Heading1`…`Heading3`, or omitted for body text. */
  style?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface DocumentContent {
  title?: string;
  creator?: string;
  paragraphs: ParagraphContent[];
}

const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  Heading1: HeadingLevel.HEADING_1,
  Heading2: HeadingLevel.HEADING_2,
  Heading3: HeadingLevel.HEADING_3,
};

export async function buildDocx(content: DocumentContent): Promise<Buffer> {
  const children = content.paragraphs.map((p) => {
    const heading = p.style ? HEADINGS[p.style] : undefined;
    return new Paragraph({
      ...(heading ? { heading } : {}),
      children: [new TextRun({ text: p.text, bold: p.bold, italics: p.italic })],
    });
  });

  const doc = new Document({
    ...(content.title ? { title: content.title } : {}),
    ...(content.creator ? { creator: content.creator } : {}),
    sections: [{ children }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
