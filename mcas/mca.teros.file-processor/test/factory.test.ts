import { describe, expect, it } from 'bun:test';
import { detectFileType, getExtension } from '../src/processors/base.js';
import { DocxProcessor } from '../src/processors/docx.js';
import { createProcessor } from '../src/processors/factory.js';
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

describe('createProcessor', () => {
  it('routes PDF to PDFProcessor with or without a key (local extraction needs none)', () => {
    expect(createProcessor('doc.pdf', 'sk-key')).toBeInstanceOf(PDFProcessor);
    expect(createProcessor('doc.pdf', '')).toBeInstanceOf(PDFProcessor);
    expect(createProcessor('doc.pdf')).toBeInstanceOf(PDFProcessor);
  });

  it('routes DOCX to DocxProcessor without needing a key (capa 2)', () => {
    expect(createProcessor('doc.docx', '')).toBeInstanceOf(DocxProcessor);
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
