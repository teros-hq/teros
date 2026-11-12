/**
 * Babel plugin (web only) — rewrites named imports from the two icon barrels to
 * one import per icon, so the bundle carries only the icons actually used.
 *
 * Metro does not tree-shake. `import { Check } from "phosphor-react-native"`
 * pulls the whole package (~5.6 MB minified) and the same import from
 * "@tamagui/lucide-icons" another ~1.3 MB; with this plugin the same line
 * becomes `import { Check } from "phosphor-react-native/src/icons/Check"`.
 *
 * A specifier whose per-icon file does not exist (or does not export that name)
 * is left on the barrel, so an unusual import never breaks the build — it just
 * keeps the barrel in the bundle, which the bundle audit makes visible.
 *
 * @spec LOADP-REQ-1
 */
const fs = require("node:fs")
const path = require("node:path")

const SOURCES = {
  "phosphor-react-native": { dir: "phosphor-react-native/src/icons", ext: [".tsx"], spec: "phosphor-react-native/src/icons" },
  "@tamagui/lucide-icons": { dir: "@tamagui/lucide-icons/dist/esm/icons", ext: [".mjs"], spec: "@tamagui/lucide-icons/icons" },
}

function findModulesDir(pkgDir) {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules", pkgDir)
    if (fs.existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  return null
}

const cache = new Map()
/**
 * The per-icon file that exports `name`, or null. Phosphor exports both `Check`
 * and `CheckIcon` from `Check.tsx`, so a `…Icon` name also looks at the file
 * without the suffix.
 */
function iconFileFor(source, name) {
  const key = `${source}:${name}`
  if (cache.has(key)) return cache.get(key)
  const cfg = SOURCES[source]
  const dir = findModulesDir(cfg.dir)
  let found = null
  if (dir) {
    const bases = name.endsWith("Icon") ? [name, name.slice(0, -4)] : [name]
    for (const base of bases) {
      for (const ext of cfg.ext) {
        const file = path.join(dir, base + ext)
        if (!fs.existsSync(file)) continue
        // The file must export this exact name (`export { X }` / `export const X`).
        const text = fs.readFileSync(file, "utf8")
        if (new RegExp(`export\\s+const\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(text)) {
          found = base
        }
      }
      if (found) break
    }
  }
  cache.set(key, found)
  return found
}

module.exports = function iconDeepImports({ types: t }) {
  return {
    name: "icon-deep-imports",
    visitor: {
      // `export { XIcon as X } from "phosphor-react-native"` (mca/primitives/icons.ts).
      ExportNamedDeclaration(p) {
        const node = p.node
        const source = node.source && node.source.value
        const cfg = source && SOURCES[source]
        if (!cfg || node.exportKind === "type") return
        const named = []
        const keep = []
        for (const s of node.specifiers) {
          const base =
            t.isExportSpecifier(s) && s.exportKind !== "type" && t.isIdentifier(s.local)
              ? iconFileFor(source, s.local.name)
              : null
          if (base) named.push({ spec: s, base })
          else keep.push(s)
        }
        if (named.length === 0) return
        const replacements = named.map(({ spec, base }) =>
          t.exportNamedDeclaration(null, [spec], t.stringLiteral(`${cfg.spec}/${base}`)),
        )
        if (keep.length > 0) {
          p.replaceWithMultiple([t.exportNamedDeclaration(null, keep, node.source), ...replacements])
        } else {
          p.replaceWithMultiple(replacements)
        }
      },
      ImportDeclaration(p) {
        const source = p.node.source.value
        const cfg = SOURCES[source]
        if (!cfg || p.node.importKind === "type") return

        const named = []
        const keep = []
        for (const s of p.node.specifiers) {
          const base =
            t.isImportSpecifier(s) && s.importKind !== "type" && t.isIdentifier(s.imported)
              ? iconFileFor(source, s.imported.name)
              : null
          if (base) named.push({ spec: s, base })
          else keep.push(s)
        }
        if (named.length === 0) return

        const deepBase = cfg.spec
        const replacements = named.map(({ spec, base }) =>
          t.importDeclaration(
            [t.importSpecifier(spec.local, spec.imported)],
            t.stringLiteral(`${deepBase}/${base}`),
          ),
        )
        if (keep.length > 0) {
          p.replaceWithMultiple([t.importDeclaration(keep, p.node.source), ...replacements])
        } else {
          p.replaceWithMultiple(replacements)
        }
      },
    },
  }
}
