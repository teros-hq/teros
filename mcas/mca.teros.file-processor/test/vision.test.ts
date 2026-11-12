import { describe, expect, it } from 'bun:test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { createOrientationDetector, renderPdfPages } from '../src/vendor/teros-ocr/index.js';

// pdf-to-images building blocks (vendor/teros-ocr local patches): colour page
// renders for vision models, and orientation for sideways/upside-down scans.

const TIMEOUT = 120_000;

function scanPng(): Buffer {
  const canvas = createCanvas(1240, 700);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1240, 700);
  g.fillStyle = '#111';
  g.font = '44px sans-serif';
  ['NOTARIA DE PRUEBA', 'Escritura numero 1234', 'Comparece Ana Garcia Lopez,', 'mayor de edad, con DNI 12345678Z.', 'Madrid, 22 de octubre de 2026'].forEach(
    (line, i) => g.fillText(line, 80, 110 + i * 110),
  );
  return canvas.toBuffer('image/png');
}

describe('renderPdfPages (colour renders for vision)', () => {
  it(
    'renders a page that has real text — regression: one @napi-rs/canvas for pdf.js (Path2D)',
    async () => {
      // A scan saved from the browser: an image plus a one-line text header.
      // pdf.js used its own nested canvas's Path2D and fill() threw on the text.
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([595, 842]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText('3/11/26, 13:13   https://be.teros.ai/media/5825e1b1', { x: 20, y: 820, size: 9, font });
      const img = await pdf.embedPng(scanPng());
      page.drawImage(img, { x: 40, y: 300, width: 515, height: 290 });
      const r = await renderPdfPages(Buffer.from(await pdf.save()), { dpi: 100 });
      expect(r.totalPages).toBe(1);
      expect(r.pages).toHaveLength(1);
      const meta = await sharp(r.pages[0].png).metadata();
      expect(meta.width).toBe(Math.floor((595 * 100) / 72));
      expect(meta.channels).toBeGreaterThanOrEqual(3); // colour, not the OCR grayscale render
    },
    TIMEOUT,
  );

  it(
    'caps pages per call and reports the rest as omitted',
    async () => {
      const pdf = await PDFDocument.create();
      for (let i = 0; i < 3; i++) pdf.addPage([200, 200]);
      const r = await renderPdfPages(Buffer.from(await pdf.save()), { dpi: 72, maxPages: 2 });
      expect(r.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
      expect(r.omitted).toBe(1);
    },
    TIMEOUT,
  );
});

describe('createOrientationDetector (straighten pages before vision)', () => {
  it(
    'leaves an upright page alone and straightens 90/180/270° pages',
    async () => {
      const detector = await createOrientationDetector();
      try {
        const scan = scanPng();
        expect(await detector.detect(scan)).toBe(0);
        for (const turned of [90, 180, 270] as const) {
          const png = await sharp(scan).rotate(turned).png().toBuffer();
          expect(await detector.detect(png)).toBe(((360 - turned) % 360) as 90 | 180 | 270);
        }
      } finally {
        await detector.dispose();
      }
    },
    TIMEOUT,
  );
});
