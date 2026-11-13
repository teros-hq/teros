import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(import.meta.dir, '../..', p), 'utf8');

describe('what mca.teros.guide publishes agrees with itself', () => {
  test("the server's version is the manifest's version", () => {
    const manifest = JSON.parse(read('manifest.json'));
    expect(read('src/index.ts')).toContain(`version: '${manifest.version}'`);
    expect(manifest.changelog[0].version).toBe(manifest.version);
  });

  test("i18n/en.json carries the manifest's changelog, word for word", () => {
    const manifest = JSON.parse(read('manifest.json'));
    const en = JSON.parse(read('i18n/en.json'));
    expect(en.changelog.map((c: { notes: string }) => c.notes)).toEqual(
      manifest.changelog.map((c: { notes: string }) => c.notes),
    );
  });
});
