export interface DocSnippet {
  title: string;
  source: string;
  description: string;
  code?: string;
  language?: string;
}

export interface LibraryCandidate {
  id: string;
  title: string;
  description: string;
  snippetsCount: number;
  reputation: 'High' | 'Medium' | 'Low' | 'Unknown';
  benchmarkScore: number;
  versions?: string[];
}

const REPUTATION_VALUES = new Set(['High', 'Medium', 'Low', 'Unknown']);

function normalizeReputation(value: unknown): LibraryCandidate['reputation'] {
  if (typeof value === 'string') {
    const cap = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    if (REPUTATION_VALUES.has(cap)) return cap as LibraryCandidate['reputation'];
  }
  return 'Unknown';
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v): v is string => typeof v === 'string');
  return arr.length > 0 ? arr : undefined;
}

export function parseLibraryCandidates(raw: unknown): LibraryCandidate[] {
  const list = extractArray(raw, ['results', 'libraries', 'data', 'items', 'candidates']);
  return list
    .map(toLibraryCandidate)
    .filter((c): c is LibraryCandidate => c !== null);
}

function extractArray(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function toLibraryCandidate(item: unknown): LibraryCandidate | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const id = (obj.id ?? obj.libraryId ?? obj.contextLibraryId ?? obj.context7CompatibleLibraryId) as string | undefined;
  if (typeof id !== 'string' || id.length === 0) return null;

  return {
    id,
    title: (obj.title ?? obj.name ?? id) as string,
    description: (obj.description ?? '') as string,
    snippetsCount: toNumber(obj.snippetsCount ?? obj.codeSnippets ?? obj.snippets, 0),
    reputation: normalizeReputation(obj.reputation ?? obj.sourceReputation),
    benchmarkScore: toNumber(obj.benchmarkScore ?? obj.score, 0),
    versions: toStringArray(obj.versions),
  };
}

export function parseDocSnippets(raw: unknown): DocSnippet[] {
  if (typeof raw === 'string') return parseSnippetsFromMarkdown(raw);

  // Context7 /v2/context with type=json shape: { codeSnippets: [{codeTitle, codeId, codeDescription, codeList: [{code, language}]}], infoSnippets: [...] }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const codeSnippets = Array.isArray(obj.codeSnippets) ? obj.codeSnippets : [];
    const infoSnippets = Array.isArray(obj.infoSnippets) ? obj.infoSnippets : [];
    if (codeSnippets.length > 0 || infoSnippets.length > 0) {
      const fromCode = codeSnippets
        .map(toContext7CodeSnippet)
        .filter((s): s is DocSnippet => s !== null);
      const fromInfo = infoSnippets
        .map(toContext7InfoSnippet)
        .filter((s): s is DocSnippet => s !== null);
      return [...fromCode, ...fromInfo];
    }
  }

  const list = extractArray(raw, ['snippets', 'results', 'data', 'items', 'docs']);
  if (list.length > 0) {
    return list.map(toDocSnippet).filter((s): s is DocSnippet => s !== null);
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const text = (obj.text ?? obj.content ?? obj.markdown) as string | undefined;
    if (typeof text === 'string') return parseSnippetsFromMarkdown(text);
  }
  return [];
}

function toContext7CodeSnippet(item: unknown): DocSnippet | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const codeList = Array.isArray(obj.codeList) ? (obj.codeList as Record<string, unknown>[]) : [];
  const first = codeList[0];
  return {
    title: (obj.codeTitle ?? obj.pageTitle ?? '(untitled)') as string,
    source: (obj.codeId ?? '') as string,
    description: (obj.codeDescription ?? '') as string,
    code: typeof first?.code === 'string' ? first.code : undefined,
    language:
      typeof first?.language === 'string'
        ? first.language
        : typeof obj.codeLanguage === 'string'
          ? obj.codeLanguage
          : undefined,
  };
}

function toContext7InfoSnippet(item: unknown): DocSnippet | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const content = obj.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  return {
    title: (obj.breadcrumb ?? '(info)') as string,
    source: (obj.pageId ?? '') as string,
    description: content,
  };
}

function toDocSnippet(item: unknown): DocSnippet | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const title = (obj.title ?? obj.name ?? '') as string;
  const source = (obj.source ?? obj.url ?? '') as string;
  const description = (obj.description ?? obj.summary ?? '') as string;
  if (!title && !source && !description) return null;
  return {
    title: title || '(untitled)',
    source,
    description,
    code: typeof obj.code === 'string' ? obj.code : undefined,
    language: typeof obj.language === 'string' ? obj.language : undefined,
  };
}

const SNIPPET_PATTERN = /^(?:#{2,4})\s+(.+?)$/gm;

export function parseSnippetsFromMarkdown(markdown: string): DocSnippet[] {
  if (!markdown.trim()) return [];

  const blocks: DocSnippet[] = [];
  const headers: { title: string; index: number }[] = [];
  for (const match of markdown.matchAll(SNIPPET_PATTERN)) {
    if (match.index === undefined) continue;
    headers.push({ title: match[1].trim(), index: match.index });
  }

  if (headers.length === 0) {
    const code = extractFirstFencedCode(markdown);
    return [
      {
        title: '(untitled)',
        source: '',
        description: stripFences(markdown).trim(),
        code: code?.code,
        language: code?.language,
      },
    ];
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : markdown.length;
    const block = markdown.slice(start, end);
    const lines = block.split('\n');
    const title = headers[i].title;
    const sourceLine = lines.find((l) => /^source:/i.test(l.trim())) ?? '';
    const source = sourceLine.replace(/^source:\s*/i, '').trim();
    const code = extractFirstFencedCode(block);
    const description = stripFences(block.split('\n').slice(1).join('\n'))
      .replace(/^source:.*$/im, '')
      .trim();

    blocks.push({
      title,
      source,
      description,
      code: code?.code,
      language: code?.language,
    });
  }
  return blocks;
}

function extractFirstFencedCode(text: string): { code: string; language?: string } | undefined {
  const match = text.match(/```(\w+)?\n([\s\S]*?)```/);
  if (!match) return undefined;
  return { code: match[2], language: match[1] || undefined };
}

function stripFences(text: string): string {
  return text.replace(/```\w*\n[\s\S]*?```/g, '');
}
