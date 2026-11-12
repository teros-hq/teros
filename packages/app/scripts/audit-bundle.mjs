#!/usr/bin/env node
/**
 * Bundle audit for the web export (LOADP-NFR-1).
 *
 *   npx expo export --platform web --source-maps --output-dir /tmp/dist
 *   node scripts/audit-bundle.mjs /tmp/dist
 *
 * Prints the eager JavaScript (what index.html loads before the first screen),
 * the heaviest packages in it, and exits 1 when a forbidden module is present.
 *
 * @spec LOADP-NFR-1
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { decode } = require("@jridgewell/sourcemap-codec")

const dist = process.argv[2]
if (!dist) {
  console.error("usage: audit-bundle.mjs <expo-export-dir>")
  process.exit(2)
}
const jsDir = path.join(dist, "_expo/static/js/web")
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8")
const eager = [...html.matchAll(/<script[^>]*src="\/_expo\/static\/js\/web\/([^"]+\.js)"/g)].map((m) => m[1])

/**
 * Two copies of Tamagui (an ESM and a CJS one) each own a React context, so a
 * component from one cannot see the other's Theme ("Missing theme" at runtime).
 */
const DUPLICATE_TAMAGUI = /@tamagui\/(web|core|helpers-icon|themes|config)\/(dist|lib)\/(cjs|commonjs)\//

/** Modules that must never reach the eager web bundle (LOADP-REQ-1..3). */
const FORBIDDEN = [
  /phosphor-react-native\/lib\/(module|commonjs)\/index/,
  /@tamagui\/lucide-icons\/dist\/(esm|cjs)\/index/,
  /node_modules\/highlight\.js\/lib\/languages\//,
  /node_modules\/refractor\/lib\/all\.js/,
  /node_modules\/@sentry\/react-native\/dist\/js\/index/, // LOADP-REQ-3: loaded on idle, not eagerly
  DUPLICATE_TAMAGUI, // LOADP-REQ-1: per-icon imports must stay on the ESM copy
]

let rawTotal = 0
let gzTotal = 0
const byPackage = new Map()
const forbidden = new Set()
for (const file of eager) {
  const full = path.join(jsDir, file)
  const code = fs.readFileSync(full, "utf8")
  rawTotal += code.length
  gzTotal += zlib.gzipSync(code, { level: 9 }).length
  const mapPath = full + ".map"
  if (!fs.existsSync(mapPath)) continue
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"))
  map.sources.forEach((s) => FORBIDDEN.some((re) => re.test(s)) && forbidden.add(s))
  const lines = code.split("\n")
  decode(map.mappings).forEach((segs, ln) => {
    const lineLen = (lines[ln] ?? "").length
    segs.forEach((seg, i) => {
      if (seg.length < 4) return
      const len = Math.max(0, (i + 1 < segs.length ? segs[i + 1][0] : lineLen) - seg[0])
      const src = map.sources[seg[1]]
      const pkg = src.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)?.pop()?.replace("node_modules/", "") ?? "app code"
      byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + len)
    })
  })
}

console.log(`eager scripts: ${eager.join(", ")}`)
console.log(`eager JS: ${(rawTotal / 1e6).toFixed(2)} MB raw, ${(gzTotal / 1e6).toFixed(2)} MB gzip`)
console.log("heaviest:")
;[...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`  ${(v / 1024).toFixed(0).padStart(6)} KB  ${k}`))
if (forbidden.size) {
  console.error(`\nFORBIDDEN modules in the eager bundle (${forbidden.size}):`)
  ;[...forbidden].slice(0, 10).forEach((s) => console.error("  " + s))
  process.exit(1)
}
console.log("\nOK: no forbidden module")
