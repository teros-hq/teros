/**
 * Image Processor — OCR local de imágenes via @teros/ocr (tesseract.js WASM).
 *
 * Soporta: png, jpg, jpeg, tiff, webp, gif, bmp.
 * No requiere API keys ni conectividad externa — todo corre en el sandbox.
 */

import { readFileSync, statSync, writeFileSync } from 'fs';
import { basename } from 'path';
import type { FileProcessor, FileProcessorOptions, ProcessorResult } from '../types.js';

/** Extensiones de imagen que el OCR puede procesar. */
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'tiff',
  'tif',
  'webp',
  'gif',
  'bmp',
]);

export class ImageProcessor implements FileProcessor {
  supportsType(fileType: string): boolean {
    return fileType === 'image';
  }

  async process(filePath: string, options?: FileProcessorOptions): Promise<ProcessorResult> {
    const startTime = Date.now();
    const fileStats = statSync(filePath);
    const fileSizeMB = fileStats.size / 1024 / 1024;

    console.log(`🖼️  Processing image: ${basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);

    const buffer = readFileSync(filePath);
    const { extractText, formatResult } = await import('../vendor/teros-ocr/index.js');

    const result = await extractText(buffer, {
      languages: ['spa', 'eng'],
      onProgress: ({ stage }) => {
        if (stage === 'ocr') console.log('  · OCR en curso…');
      },
    });

    const markdown = formatResult(result, 'markdown');
    const outputPath = `${filePath}.md`;
    writeFileSync(outputPath, markdown);

    console.log(
      `✅ Image OCR'd locally (${result.pages.length} page(s), ` +
        `confidence ${result.meanConfidence?.toFixed(0) ?? 'N/A'}%, ` +
        `${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
    );

    return {
      markdown,
      outputPath,
      metadata: {
        inputFile: filePath,
        fileType: 'image',
        fileSize: fileStats.size,
        processingTime: Date.now() - startTime,
      },
    };
  }
}

/** Check if a file extension is a supported image format. */
export function isImageExtension(ext: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}
