import { afterAll, describe, expect, it } from 'bun:test';
import { copyFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocxProcessor } from '../src/processors/docx.js';

const fixture = join(import.meta.dir, 'fixtures', 'sample.docx');
const work = join(tmpdir(), 'fp-docx-test.docx');
const workMd = `${work}.md`;

afterAll(() => {
  for (const f of [work, workMd]) {
    if (existsSync(f)) rmSync(f);
  }
});

describe('DocxProcessor', () => {
  it('extracts markdown text from a real .docx (capa 2)', async () => {
    copyFileSync(fixture, work);
    const result = await new DocxProcessor().process(work);

    expect(result.markdown).toContain('Informe Trimestral');
    expect(result.markdown).toContain('Resumen ejecutivo del primer trimestre');
    // Heading1 should become an ATX heading via turndown
    expect(result.markdown).toMatch(/^#\s+Informe Trimestral/m);
    expect(result.metadata.fileType).toBe('docx');
    expect(existsSync(result.outputPath)).toBe(true);
  });
});
