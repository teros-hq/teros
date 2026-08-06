/**
 * Terminal bundle build script
 *
 * Compiles the xterm.js TypeScript source into a minified IIFE,
 * wraps it in a self-contained HTML document, and outputs:
 *   1. dist/terminal.html — the raw HTML file (for inspection)
 *   2. ../windows/TerminalWindow/terminalBundle.ts — TypeScript module exporting the HTML as a string
 *
 * Usage:
 *   bun run build.ts
 *   bun run build  (via package.json scripts)
 */

import { build } from 'esbuild'
import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

async function buildTerminalBundle(): Promise<void> {
  console.log('🔨 Building xterm.js terminal bundle...')

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

  const xtermCss = readFileSync(
    join(import.meta.dir, 'node_modules/@xterm/xterm/css/xterm.css'),
    'utf-8'
  )

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${xtermCss}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; width: 100%; overflow: hidden; background: #282c34; }
    #terminal { height: 100%; width: 100%; overflow: hidden; }
    .xterm { height: 100%; padding: 8px; }
    .xterm-viewport { background-color: transparent !important; }
    .xterm-screen { -webkit-user-select: text; user-select: text; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>${js}</script>
</body>
</html>`

  mkdirSync(join(import.meta.dir, 'dist'), { recursive: true })
  const distPath = join(import.meta.dir, 'dist/terminal.html')
  writeFileSync(distPath, html, 'utf-8')
  console.log(`✅ HTML written to dist/terminal.html (${(html.length / 1024).toFixed(1)} KB)`)

  const tsModule = `// AUTO-GENERATED — do not edit manually.
// Run: bun run build in packages/app/src/terminal-bundle/
// Generated: ${new Date().toISOString()}
export const terminalHtml: string = ${JSON.stringify(html)};
`

  const outputPath = join(import.meta.dir, '../windows/TerminalWindow/terminalBundle.ts')
  writeFileSync(outputPath, tsModule, 'utf-8')
  console.log(`✅ TypeScript module written to TerminalWindow/terminalBundle.ts`)
  console.log(`   Total HTML size: ${(html.length / 1024).toFixed(1)} KB`)
}

buildTerminalBundle().catch((err) => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})
