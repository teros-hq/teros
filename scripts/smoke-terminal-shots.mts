/**
 * Render what smoke-terminal-agent.mts captured (SMOKE_SCREENSHOTS=<dir>) as
 * PNGs: every <name>.ans (tmux's grid with colours: what the Terminal window
 * draws) and transcript.txt (what the Teros agent read from the tools).
 *
 *   npx tsx scripts/smoke-terminal-shots.mts <dir>
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Anser from "anser"
import { chromium } from "playwright"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: smoke-terminal-shots.mts <dir>")
  process.exit(2)
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function page(title: string, body: string, width: number): string {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0d1117; }
    .frame { width: ${width}px; padding: 14px 18px; font: 13px/1.35 "SF Mono", Menlo, monospace; color: #d6dde6; }
    .title { font: 600 12px -apple-system, sans-serif; color: #8b98a8; margin-bottom: 10px; letter-spacing: .02em; }
    pre { margin: 0; white-space: pre; }
    .label { color: #7cc4ff; font-weight: 600; }
  </style><div class="frame"><div class="title">${escapeHtml(title)}</div>${body}</div>`
}

// The system Chrome: no browser download needed (PLAYWRIGHT_CHANNEL to pick another).
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" })
const tab = await browser.newPage({ deviceScaleFactor: 2 })
for (const file of readdirSync(dir).sort()) {
  let html: string | null = null
  if (file.endsWith(".ans")) {
    const ansi = readFileSync(join(dir, file), "utf8").replace(/\s+$/, "")
    const body = Anser.ansiToHtml(escapeHtml(ansi), { use_classes: false })
    html = page(
      `Claude Code in the terminal session — ${file.replace(".ans", "")} (tmux grid)`,
      `<pre>${body}</pre>`,
      1000,
    )
  } else if (file === "transcript.txt") {
    const text = readFileSync(join(dir, file), "utf8")
    const body = escapeHtml(text).replace(/^▶ (.*)$/gm, '<span class="label">▶ $1</span>')
    html = page(
      "What the Teros agent read (mca.teros.terminal tool answers)",
      `<pre>${body}</pre>`,
      1000,
    )
  }
  if (!html) continue
  const out = join(dir, file.replace(/\.(ans|txt)$/, ".png"))
  writeFileSync(join(dir, file.replace(/\.(ans|txt)$/, ".html")), html)
  await tab.setContent(html)
  const frame = await tab.$(".frame")
  await frame!.screenshot({ path: out })
  console.log(out)
}
await browser.close()
