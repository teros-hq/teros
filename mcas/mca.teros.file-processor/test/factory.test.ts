import { describe, expect, it } from 'bun:test';
import { detectFileType, getExtension } from '../src/processors/base.js';
import { DocxProcessor } from '../src/processors/docx.js';
import { createProcessor } from '../src/processors/factory.js';
import { ImageProcessor, isImageExtension } from '../src/processors/image.js';
import { PDFProcessor } from '../src/processors/pdf.js';

describe('getExtension', () => {
  it('lowercases and strips the dot', () => {
    expect(getExtension('/tmp/Report.DOCX')).toBe('docx');
    expect(getExtension('a/b/c.PDF')).toBe('pdf');
    expect(getExtension('noext')).toBe('');
  });
});

describe('detectFileType', () => {
  it('maps extensions to categories', () => {
    expect(detectFileType('x.pdf')).toBe('pdf');
    expect(detectFileType('x.docx')).toBe('document');
    expect(detectFileType('x.txt')).toBe('text');
    expect(detectFileType('x.zip')).toBeNull();
  });
});

describe('isImageExtension', () => {
  it('recognizes supported image formats', () => {
    expect(isImageExtension('png')).toBe(true);
    expect(isImageExtension('jpg')).toBe(true);
    expect(isImageExtension('jpeg')).toBe(true);
    expect(isImageExtension('tiff')).toBe(true);
    expect(isImageExtension('tif')).toBe(true);
    expect(isImageExtension('webp')).toBe(true);
    expect(isImageExtension('gif')).toBe(true);
    expect(isImageExtension('bmp')).toBe(true);
  });

  it('rejects non-image formats', () => {
    expect(isImageExtension('pdf')).toBe(false);
    expect(isImageExtension('docx')).toBe(false);
    expect(isImageExtension('svg')).toBe(false);
    expect(isImageExtension('mp3')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isImageExtension('PNG')).toBe(true);
    expect(isImageExtension('Jpg')).toBe(true);
  });
});

describe('createProcessor', () => {
  it('routes PDF to PDFProcessor with or without a key (local extraction needs none)', () => {
    expect(createProcessor('doc.pdf', 'sk-key')).toBeInstanceOf(PDFProcessor);
    expect(createProcessor('doc.pdf', '')).toBeInstanceOf(PDFProcessor);
    expect(createProcessor('doc.pdf')).toBeInstanceOf(PDFProcessor);
  });

  it('routes DOCX to DocxProcessor without needing a key (capa 2)', () => {
    expect(createProcessor('doc.docx', '')).toBeInstanceOf(DocxProcessor);
  });

  it('routes images to ImageProcessor (no key needed)', () => {
    expect(createProcessor('screenshot.png')).toBeInstanceOf(ImageProcessor);
    expect(createProcessor('photo.jpg')).toBeInstanceOf(ImageProcessor);
    expect(createProcessor('scan.tiff')).toBeInstanceOf(ImageProcessor);
    expect(createProcessor('image.webp')).toBeInstanceOf(ImageProcessor);
  });

  it('rejects legacy .doc with an actionable hint', () => {
    expect(() => createProcessor('old.doc', 'sk-key')).toThrow(/\.docx|PDF/);
  });

  it('rejects spreadsheets and presentations with an actionable hint', () => {
    expect(() => createProcessor('sheet.xlsx', 'sk-key')).toThrow(/PDF/);
    expect(() => createProcessor('deck.pptx', 'sk-key')).toThrow(/PDF/);
  });

  it('rejects unknown extensions', () => {
    expect(() => createProcessor('archive.zip', 'sk-key')).toThrow(/Unsupported file type/);
  });
});
