import { describe, expect, it } from 'bun:test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { extractText } from '../src/vendor/teros-ocr/index.js';

// Automatic orientation (vendor/teros-ocr local patch): scanned IDs and pages
// often arrive sideways or upside down, carry no EXIF orientation, and used to
// OCR as garbage. Local OCR, no LLM key involved.

async function uprightScan(): Promise<Buffer> {
  const canvas = createCanvas(1240, 700);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1240, 700);
  g.fillStyle = '#111';
  g.font = '44px sans-serif';
  [
    'NOTARIA DE PRUEBA',
    'Escritura numero 1234',
    'Comparece Ana Garcia Lopez,',
    'mayor de edad, con DNI 12345678Z.',
    'Madrid, 22 de octubre de 2026',
  ].forEach((line, i) => g.fillText(line, 80, 110 + i * 110));
  return canvas.toBuffer('image/png');
}

const OCR_TIMEOUT = 120_000;

describe('OCR automatic orientation', () => {
  it(
    'leaves an upright scan untouched',
    async () => {
      const r = await extractText(await uprightScan(), { languages: ['spa', 'eng'] });
      expect(r.text).toContain('NOTARIA DE PRUEBA');
      expect(r.pages[0].rotation).toBeUndefined();
    },
    OCR_TIMEOUT,
  );

  for (const turned of [90, 180, 270] as const) {
    it(
      `reads an image turned ${turned}° by rotating it back`,
      async () => {
        const png = await sharp(await uprightScan()).rotate(turned).png().toBuffer();
        const r = await extractText(png, { languages: ['spa', 'eng'] });
        expect(r.text).toContain('NOTARIA DE PRUEBA');
        expect(r.pages[0].rotation).toBe((360 - turned) as 90 | 180 | 270);
        expect(r.pages[0].warnings.join(' ')).toContain('girada automáticamente');
      },
      OCR_TIMEOUT,
    );
  }

  it(
    'reads a scanned PDF whose page image is sideways',
    async () => {
      const side = await sharp(await uprightScan()).rotate(90).png().toBuffer();
      const meta = await sharp(side).metadata();
      const pdf = await PDFDocument.create();
      const img = await pdf.embedPng(side);
      pdf
        .addPage([meta.width!, meta.height!])
        .drawImage(img, { x: 0, y: 0, width: meta.width!, height: meta.height! });
      const r = await extractText(Buffer.from(await pdf.save()), { languages: ['spa', 'eng'] });
      expect(r.text).toContain('NOTARIA DE PRUEBA');
      expect(r.pages[0].rotation).toBe(270);
    },
    OCR_TIMEOUT,
  );

  it(
    'can be turned off with autoRotate: false',
    async () => {
      const png = await sharp(await uprightScan()).rotate(180).png().toBuffer();
      const r = await extractText(png, { languages: ['spa', 'eng'], autoRotate: false });
      expect(r.pages[0].rotation).toBeUndefined();
    },
    OCR_TIMEOUT,
  );
});
