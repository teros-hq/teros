import { transformSync } from "@babel/core"
import { describe, expect, it } from "vitest"
// biome-ignore lint/style/noCommonJs: the plugin is a CJS Babel plugin
import plugin from "../../scripts/babel-plugin-icon-deep-imports.js"

const run = (src: string) =>
  transformSync(src, { plugins: [plugin], configFile: false, babelrc: false, sourceType: "module", parserOpts: { plugins: ["typescript"] } })!.code!

describe("babel-plugin-icon-deep-imports", () => {
  it("[LOADP-AC-1] rewrites named imports and export-from to per-icon modules, leaves the rest on the barrel", () => {
    const out = run(`
      import { CheckIcon as Check } from "phosphor-react-native"
      export { XIcon as X } from "phosphor-react-native"
      import { Columns } from "@tamagui/lucide-icons"
      import { NotAnIcon } from "phosphor-react-native"
      import type { IconProps } from "phosphor-react-native"
      import * as L from "@tamagui/lucide-icons"
    `)
    expect(out).toContain('import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check"')
    expect(out).toContain('export { XIcon as X } from "phosphor-react-native/src/icons/X"')
    expect(out).toContain('import { Columns } from "@tamagui/lucide-icons/icons/Columns"')
    // No icon file for it: stays on the barrel instead of breaking the build.
    expect(out).toContain('import { NotAnIcon } from "phosphor-react-native"')
    expect(out).toContain("import * as L from")
    expect(out).toMatch(/import type \{ IconProps \} from "phosphor-react-native"/)
  })
})
