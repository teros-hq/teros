import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { docs_v1, slides_v1 } from 'googleapis';
import { join } from 'path';

/**
 * Save buffer to downloads folder
 */
export async function saveToDownloads(
  buffer: Buffer,
  fileName: string,
  customPath?: string,
): Promise<string> {
  const outputPath = customPath || join(process.env.HOME || '/tmp', 'Downloads', fileName);

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Extract text content from a Google Slides slide
 */
export function extractTextFromSlide(slide: slides_v1.Schema$Page): string {
  const textParts: string[] = [];

  for (const element of slide.pageElements || []) {
    if (element.shape?.text) {
      const text = element.shape.text.textElements
        ?.map((el) => el.textRun?.content || '')
        .join('')
        .trim();

      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('\n');
}

/**
 * Extract text content from a Google Docs document
 */
export function extractTextFromDocument(doc: docs_v1.Schema$Document): string {
  const textParts: string[] = [];

  for (const content of doc.body?.content || []) {
    if (content.paragraph) {
      const text = content.paragraph.elements?.map((el) => el.textRun?.content || '').join('');

      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('');
}
