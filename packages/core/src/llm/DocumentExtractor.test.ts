import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  DocumentExtractor,
  formatDocumentsAsText,
  collectEmbeddedImages,
} from './DocumentExtractor';

// Mock officeparser — we don't want to spin up tesseract/pdf workers in unit tests
vi.mock('officeparser', () => ({
  OfficeParser: {
    parseOffice: vi.fn(async (_buf: Buffer) => ({
      toText: () => 'Slide 1 title\nSlide 1 body text\n\nSlide 2 title\nSlide 2 body text',
      attachments: [],
    })),
  },
}));

global.fetch = vi.fn();

describe('DocumentExtractor', () => {
  let extractor: DocumentExtractor;

  beforeEach(() => {
    extractor = new DocumentExtractor({ allowedDomains: ['example.com', 'localhost'] });
    vi.clearAllMocks();
  });

  describe('supportsDocument', () => {
    it('returns true for PPTX/DOCX/XLSX/ODT/PDF/RTF', () => {
      expect(DocumentExtractor.supportsDocument('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/vnd.oasis.opendocument.text')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/pdf')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/rtf')).toBe(true);
    });

    it('returns true for plain text MIMEs', () => {
      expect(DocumentExtractor.supportsDocument('text/plain')).toBe(true);
      expect(DocumentExtractor.supportsDocument('text/markdown')).toBe(true);
      expect(DocumentExtractor.supportsDocument('text/csv')).toBe(true);
      expect(DocumentExtractor.supportsDocument('application/json')).toBe(true);
    });

    it('returns false for image and unknown MIMEs', () => {
      expect(DocumentExtractor.supportsDocument('image/png')).toBe(false);
      expect(DocumentExtractor.supportsDocument('image/jpeg')).toBe(false);
      expect(DocumentExtractor.supportsDocument('video/mp4')).toBe(false);
      expect(DocumentExtractor.supportsDocument('application/octet-stream')).toBe(false);
      expect(DocumentExtractor.supportsDocument(undefined)).toBe(false);
      expect(DocumentExtractor.supportsDocument('')).toBe(false);
    });
  });

  describe('extractDocuments', () => {
    it('extracts text from a PPTX', async () => {
      const mockBuffer = Buffer.from('mock pptx bytes');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(mockBuffer.length) }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          url: 'https://example.com/deck.pptx',
          filename: 'deck.pptx',
        },
      ]);

      expect(result.size).toBe(1);
      const extracted = result.get('https://example.com/deck.pptx')!;
      expect(extracted.text).toContain('Slide 1 title');
      expect(extracted.filename).toBe('deck.pptx');
      expect(extracted.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    });

    it('passes through plain text MIMEs verbatim (no officeparser call)', async () => {
      const plainText = 'Hello world\nThis is a plain text file.';
      const encoded = new TextEncoder().encode(plainText);
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(encoded.byteLength) }),
        arrayBuffer: vi.fn().mockResolvedValue(encoded.buffer),
      });

      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'text/plain',
          url: 'https://example.com/notes.txt',
        },
      ]);

      expect(result.size).toBe(1);
      expect(result.get('https://example.com/notes.txt')!.text).toBe(plainText);
    });

    it('skips images entirely (delegated to ImagePipeline)', async () => {
      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'image/png',
          url: 'https://example.com/photo.png',
        },
      ]);
      expect(result.size).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('skips on 404 / non-OK responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      });

      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/pdf',
          url: 'https://example.com/missing.pdf',
        },
      ]);
      expect(result.size).toBe(0);
    });

    it('rejects URLs outside the allowlist', async () => {
      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/pdf',
          url: 'https://evil.com/leak.pdf',
        },
      ]);
      expect(result.size).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('fails-closed when no allowlist configured', async () => {
      const failClosed = new DocumentExtractor({ allowedDomains: null });
      const result = await failClosed.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/pdf',
          url: 'https://example.com/doc.pdf',
        },
      ]);
      expect(result.size).toBe(0);
    });

    it('truncates very long extractions to maxChars', async () => {
      const longText = 'x'.repeat(60_000);
      const { OfficeParser } = await import('officeparser');
      (OfficeParser.parseOffice as any).mockResolvedValueOnce({
        toText: () => longText,
      });
      const mockBuffer = Buffer.from('mock');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const tight = new DocumentExtractor({ allowedDomains: ['example.com'], maxChars: 1000 });
      const result = await tight.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          url: 'https://example.com/big.docx',
        },
      ]);
      const extracted = result.get('https://example.com/big.docx')!;
      expect(extracted.text.length).toBeLessThanOrEqual(1100); // 1000 + truncation marker
      expect(extracted.text).toContain('content truncated');
    });

    it('caches repeated extractions for the same URL', async () => {
      const mockBuffer = Buffer.from('mock');
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const part = {
        id: 'p1',
        sessionID: 's1',
        messageID: 'm1',
        type: 'file' as const,
        mime: 'application/pdf',
        url: 'https://example.com/cached.pdf',
      };
      await extractor.extractDocuments([part]);
      await extractor.extractDocuments([{ ...part, id: 'p2', messageID: 'm2' }]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatDocumentsAsText', () => {
    it('formats a single document with markers', () => {
      const docs = new Map();
      docs.set('https://x.com/a.pptx', {
        text: 'Hello slides',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        filename: 'a.pptx',
        charCount: 12,
        embeddedImages: [],
      });
      const result = formatDocumentsAsText(docs)!;
      expect(result).toContain('[Document: a.pptx]');
      expect(result).toContain('Hello slides');
      expect(result).toContain('[End of document: a.pptx]');
    });

    it('joins multiple documents with blank lines', () => {
      const docs = new Map();
      docs.set('u1', { text: 'A', mimeType: 'application/pdf', filename: 'a.pdf', charCount: 1, embeddedImages: [] });
      docs.set('u2', { text: 'B', mimeType: 'application/pdf', filename: 'b.pdf', charCount: 1, embeddedImages: [] });
      const result = formatDocumentsAsText(docs)!;
      expect(result).toContain('[Document: a.pdf]');
      expect(result).toContain('[Document: b.pdf]');
      expect(result.indexOf('a.pdf')).toBeLessThan(result.indexOf('b.pdf'));
    });

    it('annotates documents that carry embedded images', () => {
      const docs = new Map();
      docs.set('u', {
        text: 'slide text',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        filename: 'deck.pptx',
        charCount: 10,
        embeddedImages: [
          { mimeType: 'image/png', buffer: Buffer.from('a') },
          { mimeType: 'image/jpeg', buffer: Buffer.from('b') },
        ],
      });
      const result = formatDocumentsAsText(docs)!;
      expect(result).toContain('2 embedded image(s) attached separately');
    });

    it('returns null for empty Map', () => {
      expect(formatDocumentsAsText(new Map())).toBeNull();
    });
  });

  describe('embedded image extraction', () => {
    it('returns image attachments alongside text when officeparser reports them', async () => {
      const { OfficeParser } = await import('officeparser');
      const logoB64 = Buffer.from('fake-png-bytes').toString('base64');
      const chartB64 = Buffer.from('fake-chart-bytes').toString('base64');
      (OfficeParser.parseOffice as any).mockResolvedValueOnce({
        toText: () => 'Slide with embedded logo',
        attachments: [
          { type: 'image', mimeType: 'image/png', data: logoB64 },
          { type: 'chart', mimeType: 'application/vnd.oasis.opendocument.chart', data: chartB64 },
          { type: 'image', mimeType: 'image/jpeg', data: logoB64 },
        ],
      });
      const mockBuf = Buffer.from('mock-pptx');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(mockBuf.length) }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuf.buffer),
      });

      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          url: 'https://example.com/branded.pptx',
        },
      ]);
      const doc = result.get('https://example.com/branded.pptx')!;
      // 2 images extracted (chart skipped)
      expect(doc.embeddedImages).toHaveLength(2);
      expect(doc.embeddedImages[0].mimeType).toBe('image/png');
      expect(doc.embeddedImages[0].buffer.toString()).toBe('fake-png-bytes');
      expect(doc.embeddedImages[1].mimeType).toBe('image/jpeg');
    });

    it('caps embedded image count to maxImages', async () => {
      const { OfficeParser } = await import('officeparser');
      const lots = Array.from({ length: 50 }, () => ({
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('x').toString('base64'),
      }));
      (OfficeParser.parseOffice as any).mockResolvedValueOnce({
        toText: () => 'big deck',
        attachments: lots,
      });
      const mockBuf = Buffer.from('mock');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuf.buffer),
      });
      const tight = new DocumentExtractor({ allowedDomains: ['example.com'], maxImages: 5 });
      const result = await tight.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          url: 'https://example.com/many.pptx',
        },
      ]);
      expect(result.get('https://example.com/many.pptx')!.embeddedImages).toHaveLength(5);
    });

    it('collectEmbeddedImages flattens across multiple documents', () => {
      const docs = new Map();
      docs.set('u1', {
        text: 't',
        mimeType: 'application/pdf',
        filename: 'a.pdf',
        charCount: 1,
        embeddedImages: [{ mimeType: 'image/png', buffer: Buffer.from('1') }],
      });
      docs.set('u2', {
        text: 't',
        mimeType: 'application/pdf',
        filename: 'b.pdf',
        charCount: 1,
        embeddedImages: [
          { mimeType: 'image/jpeg', buffer: Buffer.from('2') },
          { mimeType: 'image/png', buffer: Buffer.from('3') },
        ],
      });
      const flat = collectEmbeddedImages(docs);
      expect(flat).toHaveLength(3);
      expect(flat.map((f) => f.filename)).toEqual(['a.pdf', 'b.pdf', 'b.pdf']);
    });

    it('returns text-only extraction when document has no images (empty array)', async () => {
      // Uses the default mock (attachments: [])
      const mockBuf = Buffer.from('pptx-no-images');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(mockBuf.length) }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuf.buffer),
      });
      const result = await extractor.extractDocuments([
        {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'file',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          url: 'https://example.com/plain.pptx',
        },
      ]);
      expect(result.get('https://example.com/plain.pptx')!.embeddedImages).toHaveLength(0);
    });
  });
});
