import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOPICS } from '../../src/content/topics';
import { searchGuide, type SearchGuideOutput } from '../../src/tools/search-guide';

const topic = GUIDE_TOPICS.find((t) => t.id === 'github');
const CTX = {} as never;
const run = (query: string) => searchGuide.handler({ query }, CTX) as Promise<SearchGuideOutput>;

describe('topic github (015)', () => {
  test('exists and stays short', () => {
    expect(topic).toBeDefined();
    expect(topic!.body.length).toBeLessThanOrEqual(4500);
  });

  test.each([
    ['tool first', /call a GitHub tool first/i],
    ['never invent', /never (reconstruct|invent)/i],
    ['reconnect lives in Teros', /Apps → GitHub/],
    ['never suggest Disconnect', /Disconnect/],
    ['ask before resetting', /ask the user before/i],
    ['own clone', /own clone/i],
    ['workflows permission', /Workflows/],
    ['not granted vs not connected', /grant/i],
  ])('says: %s', (_name, re) => {
    expect(topic!.body).toMatch(re);
  });

  test.each([['github repos not found'], ['reconnect github'], ['push workflow github actions']])(
    'search-guide "%s" → top-1',
    async (query) => {
      const out = await run(query);
      expect(out.results[0]?.id).toBe('github');
    },
  );

  test('mca.github ships the same rules as agent instructions', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../../mca.github/manifest.json'), 'utf8'));
    const text: string = manifest.agentInstructions ?? '';
    expect(text).toMatch(/call a GitHub tool first/i);
    expect(text).toMatch(/guide topic `github`/);
  });
});
