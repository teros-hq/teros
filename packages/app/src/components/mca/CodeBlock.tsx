/**
 * CodeBlock - Syntax highlighted code display
 *
 * Cross-platform component for displaying code with syntax highlighting.
 * Works on both React Native and Web via react-native-code-highlighter.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import CodeHighlighter from 'react-native-code-highlighter';
import { vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';

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

// Background color from vs2015 theme
const CODE_BG_COLOR = '#1E1E1E';

export function CodeBlock({ code, language, filename, maxHeight }: CodeBlockProps) {
  // Auto-detect language from filename if not provided
  const detectedLanguage = language || detectLanguage(filename) || 'plaintext';

  return (
    <ScrollView
      style={{
        maxHeight: maxHeight || 400,
        paddingLeft: 8,
        paddingVertical: 6,
        backgroundColor: CODE_BG_COLOR,
      }}
      horizontal={false}
      nestedScrollEnabled
    >
      <CodeHighlighter
        hljsStyle={vs2015}
        language={detectedLanguage}
        textStyle={{
          fontSize: 10,
          fontFamily:
            'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
          fontWeight: '400',
          lineHeight: 14,
        }}
        scrollViewProps={{
          style: { backgroundColor: CODE_BG_COLOR },
        }}
      >
        {code}
      </CodeHighlighter>
    </ScrollView>
  );
}

export default CodeBlock;
