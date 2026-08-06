/**
 * Editor bundle build script
 *
 * Compiles the CodeMirror 6 + Vim mode TypeScript source into a minified IIFE,
 * wraps it in a self-contained HTML document, and outputs:
 *   1. dist/editor.html — the raw HTML file (for inspection)
 *   2. ../CodeEditorWindow/editorBundle.ts — TypeScript module exporting the HTML as a string
 *
 * Usage:
 *   bun run build.ts
 *   bun run build  (via package.json scripts)
 */

import { build } from 'esbuild'
import { writeFileSync } from 'fs'
import { join } from 'path'

async function buildEditorBundle(): Promise<void> {
  console.log('🔨 Building CodeMirror editor bundle...')

  const result = await build({
    entryPoints: [join(import.meta.dir, 'src/main.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    write: false,
    platform: 'browser',
    target: ['es2020'],
    treeShaking: true,
    logLevel: 'info',
  })

  if (result.errors.length > 0) {
    console.error('❌ Build errors:', result.errors)
    process.exit(1)
  }

  const js = result.outputFiles[0].text
  console.log(`📦 Bundle size: ${(js.length / 1024).toFixed(1)} KB`)

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; width: 100%; overflow: hidden; background: #282c34; color: #abb2bf; }
    #editor { height: 100%; width: 100%; overflow: hidden; }
    .cm-editor { height: 100%; display: flex; flex-direction: column; }
    .cm-editor.cm-focused { outline: none; }
    .cm-scroller { overflow: auto; flex: 1; }
    .cm-content { -webkit-user-select: text; user-select: text; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>${js}</script>
</body>
</html>`

  // Write the raw HTML to dist/
  const distPath = join(import.meta.dir, 'dist/editor.html')
  writeFileSync(distPath, html, 'utf-8')
  console.log(`✅ HTML written to dist/editor.html (${(html.length / 1024).toFixed(1)} KB)`)

  // Generate the TypeScript module that exports the HTML as a string
  const tsModule = `// AUTO-GENERATED — do not edit manually.
// Run: bun run build in packages/app/src/editor-bundle/
// Generated: ${new Date().toISOString()}
export const editorHtml: string = ${JSON.stringify(html)};
`

  const outputPath = join(import.meta.dir, '../windows/CodeEditorWindow/editorBundle.ts')
  writeFileSync(outputPath, tsModule, 'utf-8')
  console.log(`✅ TypeScript module written to CodeEditorWindow/editorBundle.ts`)
  console.log(`   Total HTML size: ${(html.length / 1024).toFixed(1)} KB`)
}

buildEditorBundle().catch((err) => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})
