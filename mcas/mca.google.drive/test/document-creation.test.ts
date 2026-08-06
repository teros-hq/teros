/**
 * Native Google Doc creation + upload conversion (the .doc-stays-HTML bug).
 *
 * Root cause: a Drive file is only converted to a NATIVE Google format when the
 * `files.create` call carries BOTH a Google-native `requestBody.mimeType` (the
 * target) AND a source `media.mimeType` that Drive can import (e.g. text/html).
 * upload-file used to hardcode `application/octet-stream` and never set a target
 * → HTML was stored verbatim. These tests drive the real handlers against a
 * faithful mock and assert the EXACT params that reach the Drive API boundary,
 * so a regression that drops/changes the target or source mimeType turns red.
 */

import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Faithful mock of the googleapis Drive client: records the exact params of
// files.create and returns the created file shape the handler propagates.
// ---------------------------------------------------------------------------
function makeDrive() {
  const calls: Record<string, any> = {};
  const drive = {
    files: {
      create: mock(async (params: any) => {
        calls.create = params;
        return {
          data: {
            id: 'doc1',
            name: params.requestBody?.name,
            mimeType: params.requestBody?.mimeType ?? 'application/octet-stream',
            webViewLink: 'https://docs.google.com/document/d/doc1/edit',
          },
        };
      }),
    },
  };
  return { drive, calls };
}

function installLibMock(drive: any) {
  // Full barrel surface — mock.module is process-global in bun, so a partial
  // mock would leave saveToDownloads/ALL_DRIVES_LIST undefined for any other
  // test in the process that imports them (matches shared-drive.test.ts).
  mock.module('../src/lib', () => ({
    initializeGoogleClients: async () => ({ drive }),
    ensureAuthenticated: async () => {},
    withAuthRetry: async (_ctx: any, op: () => Promise<any>) => op(),
    saveToDownloads: async () => '/tmp/x',
    ALL_DRIVES: { supportsAllDrives: true },
    ALL_DRIVES_LIST: {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    },
  }));
}

const ctx = {} as any;

// ===========================================================================
// extToMime — pure helper (real module, not the barrel mock)
// ===========================================================================
describe('extToMime derives the real Content-Type from the extension', () => {
  it('maps known extensions, case-insensitive', async () => {
    const { extToMime } = await import('../src/tools/_mime');
    expect(extToMime('report.html')).toBe('text/html');
    expect(extToMime('REPORT.HTML')).toBe('text/html');
    expect(extToMime('a.pdf')).toBe('application/pdf');
    expect(extToMime('photo.PNG')).toBe('image/png');
    expect(extToMime('data.csv')).toBe('text/csv');
    expect(extToMime('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('falls back to octet-stream for unknown / extensionless names', async () => {
    const { extToMime } = await import('../src/tools/_mime');
    expect(extToMime('rawdata')).toBe('application/octet-stream');
    expect(extToMime('trailing.')).toBe('application/octet-stream');
    expect(extToMime('weird.xyz')).toBe('application/octet-stream');
  });
});

// ===========================================================================
// create-document — content → NATIVE Google Doc
// ===========================================================================
describe('create-document creates a NATIVE Google Doc (not an HTML file)', () => {
  it('default html: target=document, source=text/html, ALL_DRIVES, no parents', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { createDocument } = await import('../src/tools/create-document');

    const res = (await createDocument.handler(
      { title: 'Informe Q3', content: '<h1>Hola</h1>' },
      ctx,
    )) as { id: string; mimeType: string };

    // The two fields that TOGETHER trigger the conversion:
    expect(calls.create.requestBody.mimeType).toBe('application/vnd.google-apps.document');
    expect(calls.create.media.mimeType).toBe('text/html');
    // Metadata + shared-drive support:
    expect(calls.create.requestBody.name).toBe('Informe Q3');
    expect(calls.create.supportsAllDrives).toBe(true);
    expect(calls.create.requestBody.parents).toBeUndefined();
    expect(calls.create.fields).toBe('id, name, mimeType, webViewLink');
    // Handler propagates the bare Drive file (data, not a UI string):
    expect(res.id).toBe('doc1');
    expect(res.mimeType).toBe('application/vnd.google-apps.document');
  });

  it('contentType=markdown → source text/markdown, target still a Doc', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { createDocument } = await import('../src/tools/create-document');
    await createDocument.handler(
      { title: 'Notas', content: '# Título', contentType: 'markdown' },
      ctx,
    );
    expect(calls.create.media.mimeType).toBe('text/markdown');
    expect(calls.create.requestBody.mimeType).toBe('application/vnd.google-apps.document');
  });

  it('contentType=text → source text/plain', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { createDocument } = await import('../src/tools/create-document');
    await createDocument.handler({ title: 'Plano', content: 'solo texto', contentType: 'text' }, ctx);
    expect(calls.create.media.mimeType).toBe('text/plain');
  });

  it('parentFolderId is forwarded as parents[]', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { createDocument } = await import('../src/tools/create-document');
    await createDocument.handler(
      { title: 'En carpeta', content: '<p>x</p>', parentFolderId: 'folder-123' },
      ctx,
    );
    expect(calls.create.requestBody.parents).toEqual(['folder-123']);
  });

  it('rejects empty content / empty title / invalid contentType', async () => {
    const { drive } = makeDrive();
    installLibMock(drive);
    const { createDocument } = await import('../src/tools/create-document');
    await expect(createDocument.handler({ title: 'x', content: '' }, ctx)).rejects.toThrow(
      /content is required/,
    );
    await expect(createDocument.handler({ title: '   ', content: 'y' }, ctx)).rejects.toThrow(
      /title is required/,
    );
    await expect(
      createDocument.handler({ title: 'x', content: 'y', contentType: 'pdf' as any }, ctx),
    ).rejects.toThrow(/Invalid contentType/);
  });
});

// ===========================================================================
// upload-file — real mime derivation + optional conversion
// ===========================================================================
describe('upload-file uses the real mime and converts only when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drive-upload-'));
  const htmlPath = join(dir, 'report.html');
  const pdfPath = join(dir, 'doc.pdf');
  const noExtPath = join(dir, 'rawdata');
  writeFileSync(htmlPath, '<h1>x</h1>');
  writeFileSync(pdfPath, '%PDF-1.4');
  writeFileSync(noExtPath, 'binary');

  it('html + convertTo=document → native Doc target + text/html source', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { uploadFile } = await import('../src/tools/upload-file');
    await uploadFile.handler({ filePath: htmlPath, convertTo: 'document' }, ctx);
    expect(calls.create.requestBody.mimeType).toBe('application/vnd.google-apps.document');
    expect(calls.create.media.mimeType).toBe('text/html');
    expect(calls.create.supportsAllDrives).toBe(true);
  });

  it('derives media mime from the SOURCE filePath, NOT a custom destination fileName', async () => {
    // Regression: a clean fileName without extension ("Informe Q3") must NOT make
    // the media octet-stream — the bytes are still HTML from filePath, or Drive
    // can't match importFormats and the native Doc is never created.
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { uploadFile } = await import('../src/tools/upload-file');
    await uploadFile.handler(
      { filePath: htmlPath, fileName: 'Informe Q3', convertTo: 'document' },
      ctx,
    );
    expect(calls.create.requestBody.name).toBe('Informe Q3');
    expect(calls.create.media.mimeType).toBe('text/html'); // from filePath, not the name
    expect(calls.create.requestBody.mimeType).toBe('application/vnd.google-apps.document');
  });

  it('pdf WITHOUT convertTo → real mime, NO native target (stored as-is)', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { uploadFile } = await import('../src/tools/upload-file');
    await uploadFile.handler({ filePath: pdfPath }, ctx);
    expect(calls.create.media.mimeType).toBe('application/pdf');
    // No conversion requested → no Google-native target on the metadata.
    expect(calls.create.requestBody.mimeType).toBeUndefined();
  });

  it('extensionless file → octet-stream (safe binary default)', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { uploadFile } = await import('../src/tools/upload-file');
    await uploadFile.handler({ filePath: noExtPath }, ctx);
    expect(calls.create.media.mimeType).toBe('application/octet-stream');
  });

  it('rejects an invalid convertTo and a missing file', async () => {
    const { drive } = makeDrive();
    installLibMock(drive);
    const { uploadFile } = await import('../src/tools/upload-file');
    await expect(
      uploadFile.handler({ filePath: htmlPath, convertTo: 'bogus' as any }, ctx),
    ).rejects.toThrow(/Invalid convertTo/);
    await expect(uploadFile.handler({ filePath: '/no/such/file.txt' }, ctx)).rejects.toThrow(
      /File not found/,
    );
  });
});
