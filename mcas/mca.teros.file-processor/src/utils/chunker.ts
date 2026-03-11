/**
 * PDF Chunking utilities using pdf-lib
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { PDFDocument } from 'pdf-lib';

export interface ChunkInfo {
  path: string;
  startPage: number;
  endPage: number;
  size: number;
}

/**
 * Split a PDF into smaller chunks
 * @param pdfPath Path to the PDF file
 * @param chunkSize Number of pages per chunk
 * @returns Array of chunk file paths and metadata
 */
export async function splitPDFIntoChunks(
  pdfPath: string,
  chunkSize: number = 10,
): Promise<ChunkInfo[]> {
  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  const totalChunks = Math.ceil(totalPages / chunkSize);
  console.log(
    `📄 Detected ${totalPages} pages - splitting into ${totalChunks} chunks of ${chunkSize} pages each\n`,
  );

  const chunks: ChunkInfo[] = [];
  const tempDir = join(dirname(pdfPath), '.pdf-chunks');

  // Create temp directory for chunks
  mkdirSync(tempDir, { recursive: true });

  // Split into chunks
  for (let i = 0; i < totalPages; i += chunkSize) {
    const startPage = i;
    const endPage = Math.min(i + chunkSize - 1, totalPages - 1);

    console.log(
      `   ✂️  Creating chunk ${chunks.length + 1}/${totalChunks}: pages ${startPage + 1}-${endPage + 1}...`,
    );

    // Create new PDF with only these pages
    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(
      pdfDoc,
      Array.from({ length: endPage - startPage + 1 }, (_, idx) => startPage + idx),
    );

    pages.forEach((page: any) => chunkDoc.addPage(page));

    // Save chunk
    const chunkBytes = await chunkDoc.save();
    const chunkPath = join(tempDir, `chunk-${startPage + 1}-${endPage + 1}.pdf`);
    writeFileSync(chunkPath, chunkBytes);

    chunks.push({
      path: chunkPath,
      startPage: startPage + 1, // 1-indexed for humans
      endPage: endPage + 1,
      size: chunkBytes.length,
    });

    console.log(`   ✅ Chunk created (${(chunkBytes.length / 1024).toFixed(1)}KB)`);
  }

  return chunks;
}

/**
 * Clean up chunk files
 */
export function cleanupChunks(chunks: ChunkInfo[]): void {
  const fs = require('fs');
  const path = require('path');

  if (chunks.length === 0) return;

  const tempDir = path.dirname(chunks[0].path);

  try {
    // Delete all chunk files
    chunks.forEach((chunk) => {
      if (fs.existsSync(chunk.path)) {
        fs.unlinkSync(chunk.path);
      }
    });

    // Remove temp directory if empty
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      if (files.length === 0) {
        fs.rmdirSync(tempDir);
      }
    }
  } catch (error) {
    console.warn(`⚠️  Warning: Could not clean up chunks:`, error);
  }
}
