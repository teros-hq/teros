/**
 * Processor factory — single source of truth for routing a file to its
 * processor. Shared by the synchronous `file-to-markdown` tool and the async
 * JobWorker so both stay in sync on what is supported and how unsupported
 * types are rejected.
 */

import type { FileProcessor } from '../types.js';
import { getExtension } from './base.js';
import { DocxProcessor } from './docx.js';
import { PDFProcessor } from './pdf.js';

/** Legacy / unimplemented document formats, mapped to an actionable hint. */
const UNSUPPORTED_HINTS: Record<string, string> = {
  doc: 'Legacy .doc is not supported. Open it in Word/Google Docs and save as .docx or export to PDF, then convert that.',
  xls: 'Spreadsheets are not supported yet. Export the sheet to PDF and convert that.',
  xlsx: 'Spreadsheets are not supported yet. Export the sheet to PDF and convert that.',
  ppt: 'Presentations are not supported yet. Export the deck to PDF and convert that.',
  pptx: 'Presentations are not supported yet. Export the deck to PDF and convert that.',
};

/**
 * Select the processor for a file, or throw an actionable error if the format
 * is recognized but not (yet) supported.
 *
 * @param filePath  Absolute path to the input file.
 * @param anthropicKey  Optional. Only used as a fallback to OCR scanned PDFs;
 *   digital PDFs are extracted locally and need no key.
 */
export function createProcessor(filePath: string, anthropicKey = ''): FileProcessor {
  const ext = getExtension(filePath);

  if (ext === 'pdf') {
    return new PDFProcessor(anthropicKey);
  }

  if (ext === 'docx') {
    return new DocxProcessor();
  }

  const hint = UNSUPPORTED_HINTS[ext];
  if (hint) {
    throw new Error(hint);
  }

  throw new Error(
    `Unsupported file type ".${ext}" for markdown conversion. Supported: PDF, DOCX. ` +
      'For other formats, export to PDF and convert that.',
  );
}
