import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Config invariant (capa 1 regression): the code reads ANTHROPIC_API_KEY for
 * PDF/DOCX conversion and OPENAI_API_KEY for audio transcription. Both MUST be
 * declared as systemSecrets in the manifest, or the SDK never loads them and
 * the tools fail with a misleading "authentication" error.
 */
describe('manifest systemSecrets', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'manifest.json'), 'utf-8'),
  ) as { systemSecrets?: string[] };

  it('declares ANTHROPIC_API_KEY (used by file-to-markdown)', () => {
    expect(manifest.systemSecrets).toContain('ANTHROPIC_API_KEY');
  });

  it('declares OPENAI_API_KEY (used by audio-to-text)', () => {
    expect(manifest.systemSecrets).toContain('OPENAI_API_KEY');
  });
});
