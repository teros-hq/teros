import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { hasMeaningfulText, PDFProcessor } from '../src/processors/pdf.js';

const digital = join(tmpdir(), 'fp-pdf-digital.pdf');
const empty = join(tmpdir(), 'fp-pdf-empty.pdf');

afterAll(() => {
  for (const f of [digital, `${digital}.md`, empty, `${empty}.md`]) {
    if (existsSync(f)) rmSync(f);
  }
});

describe('hasMeaningfulText', () => {
  it('treats real prose as a text layer', () => {
    expect(hasMeaningfulText('Informe trimestral del primer periodo')).toBe(true);
  });

  it('treats empty / whitespace / tiny output as no text layer', () => {
    expect(hasMeaningfulText('')).toBe(false);
    expect(hasMeaningfulText('   \n\t ')).toBe(false);
    expect(hasMeaningfulText('a b')).toBe(false);
  });
});

describe('PDFProcessor', () => {
  it('extracts a digital PDF locally, without an LLM key (capa PDF)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Informe Trimestral Resumen ejecutivo', { x: 50, y: 700, size: 12, font });
    writeFileSync(digital, await doc.save());

    // No apiKey passed → must still work via local extraction.
    const result = await new PDFProcessor().process(digital);
    expect(result.markdown).toContain('Informe Trimestral');
    expect(result.metadata.tokensUsed).toBeUndefined(); // no LLM was used
  });

  it('runs local OCR on a PDF with no text layer, without an LLM key', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(); // blank page → no text layer → the scanned-PDF path
    writeFileSync(empty, await doc.save());

    // This used to EXPECT a failure: local OCR always threw "The API version
    // 4.10.38 does not match the Worker version 6.1.200" because unpdf (run
    // first) registers its pdf.js 6 worker globally. With the worker isolated
    // (vendor/teros-ocr), a blank page is OCR'd locally — no text, no LLM.
    const result = await new PDFProcessor('').process(empty);
    expect(result.metadata.tokensUsed).toBeUndefined(); // no LLM was used
    expect(result.markdown).toContain('teros-ocr');
  });
});
