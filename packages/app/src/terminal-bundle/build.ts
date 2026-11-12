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

import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

async function buildTerminalBundle(): Promise<void> {
  console.log("🔨 Building xterm.js terminal bundle...")

  const result = await build({
    entryPoints: [join(import.meta.dir, "src/main.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    write: false,
    platform: "browser",
    target: ["es2020"],
    treeShaking: true,
    logLevel: "info",
  })

  if (result.errors.length > 0) {
    console.error("❌ Build errors:", result.errors)
    process.exit(1)
  }

  const js = result.outputFiles[0].text
  console.log(`📦 Bundle size: ${(js.length / 1024).toFixed(1)} KB`)

  const xtermCss = readFileSync(
    join(import.meta.dir, "node_modules/@xterm/xterm/css/xterm.css"),
    "utf-8",
  )

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${xtermCss}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; width: 100%; overflow: hidden; background: #1e2127; }
    #terminal { position: absolute; inset: 6px 4px 4px 8px; overflow: hidden; }
    .xterm { height: 100%; }
    .xterm-viewport { background-color: transparent !important; }
    .xterm-screen { -webkit-user-select: text; user-select: text; }
    /* xterm parks its hidden input textarea at the terminal cursor (for IME).
       macOS draws its Caps Lock / input-source bubble next to the focused
       field's caret, i.e. over the prompt. Outside an IME composition the
       textarea sits at the bottom-right edge instead, so the bubble lands on
       the status bar, not on content; during composition xterm moves it back
       to the cursor (candidate windows stay in place). */
    .xterm:not(.composing) .xterm-helper-textarea {
      left: calc(100vw - 40px) !important;
      top: calc(100vh - 12px) !important;
      height: 1px !important;
    }
    #jump {
      position: absolute; right: 14px; bottom: 10px; z-index: 10;
      width: 28px; height: 28px; border-radius: 14px; border: 1px solid rgba(128,128,128,.35);
      background: rgba(33,29,41,.92); color: #e9e4f1; font: 14px/26px system-ui, sans-serif;
      cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .15s;
    }
    html.light #jump { background: rgba(255,255,255,.92); color: #2b2f36; }
    /* Pane states: a quiet chip, buttons only when there is something to do. */
    #state {
      position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 12;
      display: none; align-items: center; gap: 8px; max-width: calc(100% - 24px);
      padding: 5px 6px 5px 12px; border-radius: 16px; border: 1px solid rgba(128,128,128,.3);
      background: rgba(33,29,41,.95); color: #e9e4f1; font: 12px/18px system-ui, sans-serif;
      white-space: nowrap;
    }
    #state.show { display: flex; }
    #state.starting, #state.reconnecting { padding-right: 12px; }
    #state.reconnecting:has(button) { padding-right: 6px; }
    #state span { overflow: hidden; text-overflow: ellipsis; }
    #state.starting span::before, #state.reconnecting span::before {
      content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: #E5A23A; margin-right: 7px; vertical-align: 1px; animation: pulse 1.2s ease-in-out infinite;
    }
    #state.ended span::before, #state.denied span::before {
      content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: #D9534F; margin-right: 7px; vertical-align: 1px;
    }
    #state button {
      font: inherit; color: inherit; cursor: pointer; padding: 1px 10px; border-radius: 12px;
      border: 1px solid rgba(128,128,128,.4); background: transparent;
    }
    #state button:hover { background: rgba(128,128,128,.18); }
    html.light #state { background: rgba(255,255,255,.95); color: #2b2f36; }
    @keyframes pulse { 50% { opacity: .35; } }
    #jump.show { opacity: 1; pointer-events: auto; }
    /* xterm 6 draws its own (VS Code) scrollbar, 14px wide: keep it slim and quiet. */
    .xterm .xterm-scrollable-element > .scrollbar.vertical { width: 7px !important; }
    .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider {
      width: 5px !important; left: 1px !important; border-radius: 3px;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <button id="jump" type="button" title="Jump to the bottom" aria-label="Jump to the bottom">↓</button>
  <div id="state" role="status" aria-live="polite"></div>
  <script>${js}</script>
</body>
</html>`

  mkdirSync(join(import.meta.dir, "dist"), { recursive: true })
  const distPath = join(import.meta.dir, "dist/terminal.html")
  writeFileSync(distPath, html, "utf-8")
  console.log(`✅ HTML written to dist/terminal.html (${(html.length / 1024).toFixed(1)} KB)`)

  const tsModule = `// AUTO-GENERATED — do not edit manually.
// Run: bun run build in packages/app/src/terminal-bundle/
// Generated: ${new Date().toISOString()}
export const terminalHtml: string = ${JSON.stringify(html)};
`

  const outputPath = join(import.meta.dir, "../windows/TerminalWindow/terminalBundle.ts")
  writeFileSync(outputPath, tsModule, "utf-8")
  console.log(`✅ TypeScript module written to TerminalWindow/terminalBundle.ts`)
  console.log(`   Total HTML size: ${(html.length / 1024).toFixed(1)} KB`)
}

buildTerminalBundle().catch((err) => {
  console.error("❌ Build failed:", err)
  process.exit(1)
})
