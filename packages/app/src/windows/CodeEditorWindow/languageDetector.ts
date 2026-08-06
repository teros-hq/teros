/**
 * languageDetector — maps file extensions to CodeMirror language identifiers
 *
 * The returned strings match what the editor bundle's getLanguageExtension() expects.
 */

const EXT_TO_LANGUAGE: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  // Python
  py: 'python',
  // Data formats
  json: 'json',
  jsonc: 'json',
  // Markup
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  // Styles
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  // Config / data
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'plaintext',
  ini: 'plaintext',
  cfg: 'plaintext',
  conf: 'plaintext',
  env: 'plaintext',
  // Database
  sql: 'sql',
  // XML
  xml: 'xml',
  svg: 'xml',
  // Plain text
  txt: 'plaintext',
}

/**
 * Returns the CodeMirror language identifier for the given file path.
 * Falls back to 'plaintext' for unknown extensions.
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext'
}
