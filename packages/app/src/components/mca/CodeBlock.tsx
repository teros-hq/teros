/**
 * CodeBlock - Syntax highlighted code display
 *
 * Web: the same Prism registry the Markdown renderer uses (MD-UNIFY), so a
 * code block looks the same in a tool result and in a message. It replaces
 * react-native-code-highlighter, whose highlight.js + full Prism language sets
 * were ~2 MB of the bundle. Languages outside the registry render unhighlighted.
 * Native: plain monospace text.
 *
 * @spec LOADP-REQ-2
 */

import React from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import { SyntaxHighlighter, prismStyle } from '../markdown/highlight';
import { surface } from './primitives/colors';
import { useColors } from './primitives/useColors';

// Map file extensions to language names
const extensionToLanguage: Record<string, string> = {
  // JavaScript/TypeScript
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mjs: 'javascript',
  cjs: 'javascript',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',

  // Data
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'toml',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',

  // Python
  py: 'python',
  pyw: 'python',

  // Ruby
  rb: 'ruby',
  erb: 'erb',

  // Go
  go: 'go',

  // Rust
  rs: 'rust',

  // C/C++
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',

  // Java/Kotlin
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',

  // Swift
  swift: 'swift',

  // PHP
  php: 'php',

  // SQL
  sql: 'sql',

  // Markdown
  md: 'markdown',
  mdx: 'markdown',

  // Docker
  dockerfile: 'dockerfile',

  // Config files
  env: 'bash',
  gitignore: 'bash',
  dockerignore: 'bash',
};

/**
 * Detect language from filename
 */
function detectLanguage(filename?: string): string | undefined {
  if (!filename) return undefined;

  const lower = filename.toLowerCase();

  // Handle special filenames
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower.endsWith('.env') || lower.includes('.env.')) return 'bash';

  // Extract extension
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return undefined;

  const ext = filename.slice(lastDot + 1).toLowerCase();
  return extensionToLanguage[ext];
}

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  maxHeight?: number;
}

/**
 * Add line numbers to code in format "00001| code"
 */
export function addLineNumbers(code: string, startLine: number = 1): string {
  const lines = code.split('\n');
  return lines
    .map((line, idx) => `${String(startLine + idx).padStart(5, '0')}| ${line}`)
    .join('\n');
}

// Background color for the code surface — uses the design system's inner
// surface token so it adapts to light/dark. The hljs vs2015 theme handles
// syntax token colors (those are theme-agnostic on the dark bg).
const CODE_BG_DARK = '#1E1E1E';
const CODE_BG_LIGHT = 'rgba(10,10,15,0.05)';

export function CodeBlock({ code, language, filename, maxHeight }: CodeBlockProps) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const codeBg = isDark ? CODE_BG_DARK : CODE_BG_LIGHT;

  // Auto-detect language from filename if not provided
  const detectedLanguage = language || detectLanguage(filename) || 'plaintext';

  return (
    <ScrollView
      style={{
        maxHeight: maxHeight || 400,
        paddingLeft: 8,
        paddingVertical: 6,
        backgroundColor: codeBg,
      }}
      horizontal={false}
      nestedScrollEnabled
    >
      {Platform.OS === 'web' ? (
        <SyntaxHighlighter
          language={detectedLanguage}
          style={prismStyle(isDark)}
          customStyle={{
            margin: 0,
            padding: 0,
            background: 'transparent',
            fontSize: 10,
            lineHeight: '14px',
          }}
          codeTagProps={{ style: { fontFamily: 'inherit' } }}
          PreTag="div"
          showLineNumbers={false}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <Text style={{ fontSize: 10, lineHeight: 14, fontWeight: '400', color: isDark ? '#D4D4D4' : c.text }}>
          {code}
        </Text>
      )}
    </ScrollView>
  );
}

export default CodeBlock;
