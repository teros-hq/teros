import { rgPath } from '@vscode/ripgrep';
import { execa } from 'execa';
import { LIMITS } from './limits';

export interface GrepMatch {
  file: string;
  lineNumber: number;
  matchText: string;
  lineText: string;
  contextBefore: Array<{ lineNumber: number; text: string }>;
  contextAfter: Array<{ lineNumber: number; text: string }>;
}

export interface RipgrepResult {
  matches: GrepMatch[];
  files: Array<{ file: string; matchCount: number }>;
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}

export interface RipgrepOptions {
  pattern: string;
  path: string;
  contextBefore?: number;
  contextAfter?: number;
  include?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
  maxMatches?: number;
  maxFiles?: number;
  respectGitignore?: boolean;
  timeoutMs?: number;
}

interface RgEvent {
  type: 'begin' | 'match' | 'context' | 'end' | 'summary';
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    submatches?: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function buildArgs(options: RipgrepOptions): string[] {
  const args: string[] = ['--json', '-e', options.pattern];
  if (options.caseInsensitive) args.push('-i');
  if (options.multiline) args.push('--multiline', '--multiline-dotall');
  if (options.contextBefore && options.contextBefore > 0) {
    args.push('--before-context', String(options.contextBefore));
  }
  if (options.contextAfter && options.contextAfter > 0) {
    args.push('--after-context', String(options.contextAfter));
  }
  if (options.include) {
    args.push('--glob', options.include);
  }
  if (options.type) {
    args.push('--type', options.type);
  }
  if (!options.respectGitignore) {
    args.push('--no-ignore-vcs');
  }
  // Always skip node_modules and .git by default (user can opt out with --no-ignore-vcs patterns)
  args.push('--glob', '!node_modules', '--glob', '!.git');
  args.push('--', options.path);
  return args;
}

export async function runRipgrep(options: RipgrepOptions): Promise<RipgrepResult> {
  const maxMatches = options.maxMatches ?? LIMITS.MAX_MATCHES;
  const timeoutMs = options.timeoutMs ?? LIMITS.RIPGREP_TIMEOUT_MS;

  const args = buildArgs(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const matches: GrepMatch[] = [];
  const fileMap = new Map<string, number>();
  let truncated = false;
  let currentFile: string | null = null;
  let pendingContextBefore: Array<{ lineNumber: number; text: string }> = [];
  let lastMatch: GrepMatch | null = null;

  try {
    const child = execa(rgPath, args, {
      cancelSignal: controller.signal,
      reject: false, // rg exit 1 = no matches; not a throw
      maxBuffer: 50 * 1024 * 1024,
      stripFinalNewline: false,
    });

    const stdout = child.stdout;
    if (!stdout) throw new Error('ripgrep produced no stdout stream');

    let buffer = '';
    for await (const chunk of stdout) {
      buffer += chunk.toString('utf-8');
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');
        if (!line) continue;
        let event: RgEvent;
        try {
          event = JSON.parse(line) as RgEvent;
        } catch {
          continue;
        }
        if (event.type === 'begin') {
          currentFile = event.data.path?.text ?? null;
          pendingContextBefore = [];
          lastMatch = null;
        } else if (event.type === 'context') {
          const lineNumber = event.data.line_number ?? 0;
          const text = (event.data.lines?.text ?? '').replace(/\n$/, '');
          if (lastMatch) {
            lastMatch.contextAfter.push({ lineNumber, text });
          } else {
            pendingContextBefore.push({ lineNumber, text });
            if (pendingContextBefore.length > (options.contextBefore ?? 0)) {
              pendingContextBefore.shift();
            }
          }
        } else if (event.type === 'match') {
          if (matches.length >= maxMatches) {
            truncated = true;
            continue;
          }
          const file = event.data.path?.text ?? currentFile ?? '';
          const lineNumber = event.data.line_number ?? 0;
          const lineText = (event.data.lines?.text ?? '').replace(/\n$/, '');
          const matchText = event.data.submatches?.[0]?.match.text ?? lineText;
          const match: GrepMatch = {
            file,
            lineNumber,
            matchText,
            lineText,
            contextBefore: [...pendingContextBefore],
            contextAfter: [],
          };
          matches.push(match);
          fileMap.set(file, (fileMap.get(file) ?? 0) + 1);
          lastMatch = match;
          pendingContextBefore = [];
        } else if (event.type === 'end') {
          lastMatch = null;
          pendingContextBefore = [];
          currentFile = null;
        }
      }
    }

    await child;
  } finally {
    clearTimeout(timer);
  }

  const files = Array.from(fileMap.entries())
    .map(([file, matchCount]) => ({ file, matchCount }))
    .sort((a, b) => b.matchCount - a.matchCount);

  return {
    matches,
    files,
    totalMatches: matches.length,
    totalFiles: files.length,
    truncated,
  };
}
