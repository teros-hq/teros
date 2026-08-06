import { describe, expect, test } from 'bun:test';
import { parseDocSnippets, parseLibraryCandidates } from '../../src/lib/parser';

describe('parseLibraryCandidates', () => {
  test('parses Context7 /v2/libs/search shape', () => {
    const raw = {
      results: [
        {
          id: '/reactjs/react.dev',
          title: 'React',
          description: 'React docs',
          snippetsCount: 2400,
          reputation: 'High',
          benchmarkScore: 91.2,
          versions: ['v18_3_1', 'v19_2_0'],
        },
      ],
    };
    const out = parseLibraryCandidates(raw);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('/reactjs/react.dev');
    expect(out[0].reputation).toBe('High');
    expect(out[0].benchmarkScore).toBeCloseTo(91.2);
    expect(out[0].versions).toEqual(['v18_3_1', 'v19_2_0']);
  });

  test('handles legacy snake_case fields and missing reputation', () => {
    const raw = [
      {
        contextLibraryId: '/foo/bar',
        name: 'Foo',
        description: '',
        snippets: '300',
        score: 70,
      },
    ];
    const out = parseLibraryCandidates(raw);
    expect(out[0].id).toBe('/foo/bar');
    expect(out[0].snippetsCount).toBe(300);
    expect(out[0].reputation).toBe('Unknown');
    expect(out[0].benchmarkScore).toBe(70);
  });

  test('skips entries without id', () => {
    const out = parseLibraryCandidates({ results: [{ title: 'orphan' }, { id: '/ok/x', title: 'ok' }] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('/ok/x');
  });

  test('returns empty array for unknown shape', () => {
    expect(parseLibraryCandidates({})).toEqual([]);
    expect(parseLibraryCandidates(null)).toEqual([]);
    expect(parseLibraryCandidates('garbage')).toEqual([]);
  });
});

describe('parseDocSnippets — Context7 /v2/context shape', () => {
  test('parses codeSnippets[] with codeList', () => {
    const raw = {
      codeSnippets: [
        {
          codeTitle: 'useEffect',
          codeId: 'https://github.com/reactjs/react.dev/blob/main/x.md',
          codeDescription: 'Synchronizes a component with an external system.',
          codeLanguage: 'APIDOC',
          codeList: [{ language: 'APIDOC', code: '## useEffect\n...' }],
        },
      ],
    };
    const out = parseDocSnippets(raw);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('useEffect');
    expect(out[0].source).toBe('https://github.com/reactjs/react.dev/blob/main/x.md');
    expect(out[0].language).toBe('APIDOC');
    expect(out[0].code).toContain('useEffect');
  });

  test('also includes infoSnippets[] in output', () => {
    const raw = {
      codeSnippets: [],
      infoSnippets: [
        { breadcrumb: 'react/hooks', content: 'Hooks let you use state.', pageId: 'page1' },
      ],
    };
    const out = parseDocSnippets(raw);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('react/hooks');
    expect(out[0].description).toBe('Hooks let you use state.');
    expect(out[0].code).toBeUndefined();
  });

  test('parses markdown text fallback', () => {
    const md = `### useEffect

Source: https://example.com/foo

Synchronizes a component.

\`\`\`ts
useEffect(() => {}, []);
\`\`\``;
    const out = parseDocSnippets(md);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('useEffect');
    expect(out[0].source).toBe('https://example.com/foo');
    expect(out[0].language).toBe('ts');
    expect(out[0].code).toContain('useEffect(() =>');
  });

  test('returns empty for empty input', () => {
    expect(parseDocSnippets({})).toEqual([]);
    expect(parseDocSnippets(null)).toEqual([]);
  });
});
