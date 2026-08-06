/**
 * PDF Processor with intelligent chunking
 */

import { readFileSync, statSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { extractText, getDocumentProxy } from 'unpdf';
import type {
  ClaudeMessage,
  ClaudeResponse,
  FileProcessor,
  FileProcessorOptions,
  FileType,
  ProcessorResult,
} from '../types.js';
import { type ChunkInfo, cleanupChunks, splitPDFIntoChunks } from '../utils/chunker.js';
import {
  type ChunkResult,
  calculateTotalTokens,
  consolidateChunks,
} from '../utils/consolidator.js';

const MAX_FILE_SIZE_MB = 3; // Process in chunks if larger than this (lowered to 3MB)

/**
 * Heuristic: does the locally-extracted text indicate a real text layer?
 * A scanned/image-only PDF yields little or no extractable text; a digital PDF
 * yields its actual content. We strip whitespace and require a small minimum so
 * a stray header on a scan doesn't count as "has text".
 */
export function hasMeaningfulText(text: string): boolean {
  return text.replace(/\s+/g, '').length >= 8;
}

export class PDFProcessor implements FileProcessor {
  private apiKey: string;

  // apiKey is optional: it is only needed to OCR scanned PDFs via an LLM.
  // Digital PDFs (the common case) are extracted locally with no LLM at all.
  constructor(apiKey = '') {
    this.apiKey = apiKey;
  }

  supportsType(fileType: FileType): boolean {
    return fileType === 'pdf';
  }

  async process(filePath: string, options?: FileProcessorOptions): Promise<ProcessorResult> {
    const startTime = Date.now();
    const fileStats = statSync(filePath);
    const fileSizeMB = fileStats.size / 1024 / 1024;

    console.log(`📄 Processing PDF: ${basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);

    // 1) Primary path: extract the text layer locally (no LLM, no provider, no
    //    cost). This handles the vast majority of PDFs and works even when no
    //    LLM is configured on the platform.
    const localText = await this.extractLocally(filePath);
    if (localText && hasMeaningfulText(localText)) {
      console.log(`✅ Extracted ${localText.length} chars locally (no LLM)`);
      const outputPath = `${filePath}.md`;
      writeFileSync(outputPath, localText);
      return {
        markdown: localText,
        outputPath,
        metadata: {
          inputFile: filePath,
          fileType: 'pdf',
          fileSize: fileStats.size,
          processingTime: Date.now() - startTime,
        },
      };
    }

    // 2) No text layer → scanned/image-only PDF. This needs vision (OCR via an
    //    LLM). Only possible if a system LLM key is configured; otherwise fail
    //    loud with an actionable message instead of pretending it worked.
    console.log('🔍 No extractable text layer (likely a scanned PDF)');
    if (!this.apiKey) {
      throw new Error(
        `[NO_TEXT_LAYER] "${basename(filePath)}" looks like a scanned/image-only PDF with no extractable text, ` +
          'and no system LLM is configured to OCR it. ' +
          'Re-save the PDF with a text layer (run OCR on it) and try again.',
      );
    }

    return this.processWithLlm(filePath, fileSizeMB, fileStats.size, startTime, options);
  }

  /** Fallback: OCR a scanned PDF via the LLM (chunked for large files). */
  private async processWithLlm(
    filePath: string,
    fileSizeMB: number,
    fileSize: number,
    startTime: number,
    options?: FileProcessorOptions,
  ): Promise<ProcessorResult> {
    console.log('🤖 Falling back to LLM vision extraction…');
    const shouldChunk = fileSizeMB > MAX_FILE_SIZE_MB;
    const chunkSize = options?.chunkSize || 10;

    const result = shouldChunk
      ? await this.processInChunks(filePath, chunkSize, options)
      : { ...(await this.processDirect(filePath, options)), chunksProcessed: 0 };

    const outputPath = `${filePath}.md`;
    writeFileSync(outputPath, result.markdown);
    console.log(`✅ PDF OCR'd via LLM (${result.markdown.length} chars)`);

    return {
      markdown: result.markdown,
      outputPath,
      metadata: {
        inputFile: filePath,
        fileType: 'pdf',
        fileSize,
        processingTime: Date.now() - startTime,
        tokensUsed: result.tokensUsed,
        chunks: result.chunksProcessed || undefined,
      },
    };
  }

  /**
   * Extract the PDF's text layer locally via unpdf (pdf.js). Returns the merged
   * text, or null if extraction throws (corrupt/encrypted PDF).
   */
  private async extractLocally(filePath: string): Promise<string | null> {
    try {
      const buffer = readFileSync(filePath);
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return text.trim();
    } catch (err) {
      console.log(
        `   ⚠️  Local PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Process PDF directly (for small files)
   */
  private async processDirect(
    filePath: string,
    options?: FileProcessorOptions,
  ): Promise<{ markdown: string; tokensUsed: { input: number; output: number } }> {
    const fileData = readFileSync(filePath);
    const base64Data = fileData.toString('base64');

    const messages: ClaudeMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: this.getConversionPrompt(),
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Data,
            },
          },
        ],
      },
    ];

    const timeout = options?.timeout || 180000; // 3 minutes default
    const response = await this.sendToClaude(messages, timeout);

    return {
      markdown: response.content[0].text,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  }

  /**
   * Process PDF in chunks (for large files)
   */
  private async processInChunks(
    filePath: string,
    chunkSize: number,
    options?: FileProcessorOptions,
  ): Promise<{
    markdown: string;
    tokensUsed: { input: number; output: number };
    chunksProcessed: number;
  }> {
    let chunks: ChunkInfo[] = [];

    try {
      // Split PDF
      chunks = await splitPDFIntoChunks(filePath, chunkSize);
      console.log(`📦 Created ${chunks.length} chunks\n`);

      // Process each chunk
      const results: ChunkResult[] = [];
      const maxRetries = options?.maxRetries || 3;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const totalPages = chunks[chunks.length - 1].endPage;
        console.log(
          `\n🔄 Processing pages ${chunk.startPage}-${chunk.endPage} of ${totalPages} (chunk ${i + 1}/${chunks.length})...`,
        );

        let attempt = 0;
        let success = false;
        let result: ChunkResult | null = null;

        while (attempt < maxRetries && !success) {
          try {
            if (attempt > 0) {
              console.log(`   ⏳ Attempt ${attempt + 1}/${maxRetries}...`);
            }
            const chunkData = readFileSync(chunk.path);
            const base64Data = chunkData.toString('base64');

            const messages: ClaudeMessage[] = [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: this.getConversionPrompt(chunk.startPage, chunk.endPage, chunks.length),
                  },
                  {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: base64Data,
                    },
                  },
                ],
              },
            ];

            // Shorter timeout per chunk (2 minutes)
            const chunkTimeout = options?.timeout || 120000;
            const response = await this.sendToClaude(messages, chunkTimeout);

            result = {
              chunkIndex: i,
              startPage: chunk.startPage,
              endPage: chunk.endPage,
              markdown: response.content[0].text,
              tokensUsed: {
                input: response.usage.input_tokens,
                output: response.usage.output_tokens,
              },
            };

            success = true;
            console.log(
              `   ✅ Pages ${chunk.startPage}-${chunk.endPage} completed (${result.tokensUsed.input} tokens in / ${result.tokensUsed.output} tokens out)`,
            );
          } catch (error) {
            attempt++;
            console.log(`   ❌ Failed:`, error instanceof Error ? error.message : error);

            if (attempt < maxRetries) {
              console.log(`   🔄 Retrying in 2 seconds...`);
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
        }

        if (!result) {
          throw new Error(`Failed to process chunk ${i + 1} after ${maxRetries} attempts`);
        }

        results.push(result);
      }

      // Consolidate results
      console.log(`\n🔗 Consolidating ${results.length} chunks...`);
      const markdown = consolidateChunks(results);
      const tokensUsed = calculateTotalTokens(results);

      return {
        markdown,
        tokensUsed,
        chunksProcessed: chunks.length,
      };
    } finally {
      // Clean up chunks
      if (chunks.length > 0) {
        console.log(`🧹 Cleaning up temporary chunks...`);
        cleanupChunks(chunks);
      }
    }
  }

  /**
   * Send request to Claude API
   */
  private async sendToClaude(
    messages: ClaudeMessage[],
    timeoutMs: number,
  ): Promise<ClaudeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16000,
          messages,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Claude API error: ${response.status} ${error}`);
      }

      return (await response.json()) as ClaudeResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`The operation timed out.`);
      }
      throw error;
    }
  }

  /**
   * Get conversion prompt for Claude
   */
  private getConversionPrompt(startPage?: number, endPage?: number, totalChunks?: number): string {
    const chunkInfo =
      startPage && endPage
        ? `\n\nNote: This is part ${Math.floor((startPage - 1) / 10) + 1} of ${totalChunks} from the original document (pages ${startPage}-${endPage}).`
        : '';

    return `Convert this PDF content to well-structured Markdown format.

Instructions:
- Extract ALL text content accurately and completely
- Preserve the document structure (headings, sections, lists)
- Convert tables to Markdown tables (use | pipes)
- Preserve important formatting (bold, italic, code)
- For financial reports: highlight key metrics, numbers, and trends
- For presentations: preserve slide structure with clear separation
- For spreadsheets: convert sheets to tables with appropriate headers
- Use appropriate heading levels (# ## ### ####)
- Keep the markdown clean, readable, and properly formatted
- Include all data, don't summarize or skip content${chunkInfo}

Return ONLY the markdown content, no additional commentary or explanation.`;
  }
}
