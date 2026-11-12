/**
 * Public share pages render markdown through the platform policy
 * (@teros/shared/markdown, MD-UNIFY v2 surface 9): `~` literal (MD-STRIKE-1),
 * raw HTML stripped, unsafe URLs dropped. No database needed.
 */
import { describe, expect, it } from 'bun:test';
import { renderMarkdown } from '@teros/shared/markdown';

describe('share page markdown policy', () => {
  it('[MD-STRIKE-1] ~~x~~ and ~50ms stay literal, never <del>', () => {
    const html = renderMarkdown('about ~50ms and ~~gone~~ here');
    expect(html).not.toContain('<del');
    expect(html).toContain('~50ms');
    expect(html).toContain('~~gone~~');
  });

  it('strips raw HTML and javascript: links', () => {
    const html = renderMarkdown('hi <script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});
