/**
 * DOCX Processor
 *
 * Extracts text from Word .docx files into structured Markdown.
 *
 * Strategy: mammoth converts .docx → HTML preserving structure (headings,
 * lists, tables, bold/italic), then turndown converts that HTML → Markdown.
 * This is the route mammoth recommends (its own `convertToMarkdown` is
 * deprecated). No LLM call is needed: extraction is local, instant and free.
 *
 * Only the modern `.docx` (Office Open XML) format is supported. Legacy binary
 * `.doc` is a different format that mammoth cannot read and is rejected with an
 * actionable error upstream (see index.ts / job-worker.ts).
 */

import { readFileSync, statSync, writeFileSync } from 'fs';
import { basename } from 'path';
import * as mammoth from 'mammoth';
import TurndownService from 'turndown';
// @ts-expect-error - turndown-plugin-gfm ships no types
import { gfm } from 'turndown-plugin-gfm';
import type {
  FileProcessor,
  FileProcessorOptions,
  FileType,
  ProcessorResult,
} from '../types.js';

export class DocxProcessor implements FileProcessor {
  supportsType(fileType: FileType): boolean {
    return fileType === 'document';
  }

  async process(filePath: string, _options?: FileProcessorOptions): Promise<ProcessorResult> {
    const startTime = Date.now();
    const fileStats = statSync(filePath);
    const fileSizeMB = fileStats.size / 1024 / 1024;

    console.log(`📄 Processing DOCX: ${basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);

    const buffer = readFileSync(filePath);
    const { value: html, messages } = await mammoth.convertToHtml({ buffer });

    for (const message of messages) {
      if (message.type === 'warning' || message.type === 'error') {
        console.log(`   ⚠️  mammoth ${message.type}: ${message.message}`);
      }
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    turndown.use(gfm);
    const markdown = turndown.turndown(html).trim();

    if (!markdown) {
      throw new Error(
        'The .docx file was read but contained no extractable text (it may be empty or image-only). ' +
          'If it is a scanned document, export it to PDF and convert that instead.',
      );
    }

    const outputPath = `${filePath}.md`;
    writeFileSync(outputPath, markdown);

    const processingTime = Date.now() - startTime;
    console.log(`✅ DOCX processed (${markdown.length} chars, ${(processingTime / 1000).toFixed(1)}s)`);

    return {
      markdown,
      outputPath,
      metadata: {
        inputFile: filePath,
        fileType: 'docx',
        fileSize: fileStats.size,
        processingTime,
      },
    };
  }
}
