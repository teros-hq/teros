/// <reference types="vitest" />
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Component/render test harness (TER-385).
 *
 * Teros runs as React Native for Web (PWA), so we test against react-native-web
 * — exactly what ships in the browser — instead of native RN (whose Flow source
 * bun/jsdom cannot parse). Reuses Vitest (no 4th runner).
 *
 * No @vitejs/plugin-react: it pulls a Vite version that conflicts with the
 * repo's pinned Vite. Vitest's esbuild handles the automatic JSX runtime.
 *
 * jsdom vs browser mode: we run in jsdom (fast, zero extra infra in CI) and
 * accept the small set of environment shims in vitest.setup.ts (matchMedia,
 * no-op rAF, native-module mocks). Tamagui has no official jsdom unit-test
 * recipe and tests its own components in a real browser via Playwright; if these
 * render tests ever need to assert real layout/animation, the upgrade path is
 * Vitest browser mode (Playwright provider), which drops the jsdom shims. For a
 * structure-asserting foundation, jsdom is the right pragmatic default.
 *
 * Icon barrel stub: `primitives/icons.ts` re-exports 1000+ phosphor SVG modules.
 * Importing it hangs the jsdom worker, and the package is externalized so neither
 * resolve.alias, deps.inline nor vi.mock can intercept it. We instead redirect
 * the SOURCE barrel (which always goes through Vite) to a no-op stub via a
 * pre-resolveId plugin — phosphor is then never imported. See src/test/iconsStub.tsx.
 */
const iconsBarrel = resolve(process.cwd(), 'src/components/mca/primitives/icons.ts')
const iconsStub = resolve(process.cwd(), 'src/test/iconsStub.tsx')
// Chat bubbles import icons straight from `@tamagui/lucide-icons` (Flow-typed,
// hangs the jsdom worker). Alias the package to an enumerated no-op stub.
const lucideStub = resolve(process.cwd(), 'src/test/lucideStub.tsx')
// `react-native-svg` deep-imports Flow-typed source (esbuild chokes on `typeof`).
// Reached via TerosLoading → Voice/Audio bubbles. Alias to a no-op stub.
const reactNativeSvgStub = resolve(process.cwd(), 'src/test/reactNativeSvgStub.tsx')
// `react-native-render-html` + `@native-html/table-plugin` are also Flow-typed.
// Reached by MarkdownContent and (transitively) the mca barrel → ToolCallBlock.
const renderHtmlStub = resolve(process.cwd(), 'src/test/reactNativeRenderHtmlStub.tsx')
const tablePluginStub = resolve(process.cwd(), 'src/test/nativeHtmlTablePluginStub.tsx')
// `posthog-react-native` ships Flow-typed source (esbuild chokes on `typeof`).
// Reached via lib/analytics → track() from chat hooks. Alias to a no-op stub.
const posthogStub = resolve(process.cwd(), 'src/test/posthogStub.ts')
// `react-native-safe-area-context` deep-imports Flow-typed native source (esbuild
// chokes on `typeof`). Reached via McaStatusDashboard's bottom Sheet padding
// (useSafeAreaInsets). Alias to a zero-inset no-op stub.
const safeAreaContextStub = resolve(process.cwd(), 'src/test/reactNativeSafeAreaContextStub.tsx')

export default defineConfig({
  plugins: [
    {
      name: 'stub-mca-icons',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        if (!importer || !source.endsWith('icons')) return null
        const resolved = await this.resolve(source, importer, { skipSelf: true, ...options })
        if (resolved && resolved.id === iconsBarrel) return iconsStub
        return null
      },
    },
    {
      // Window definitions import their heavy content component DIRECTLY (non-lazy)
      // as `./XxxWindowContent`, so loading the registry drags in the whole render
      // graph (Lexical, xterm, Monaco…). The roundtrip test only exercises
      // serialize/deserialize, so stub every *WindowContent module with a no-op that
      // exposes the matching named export (generated per path → no 30-name enum).
      //
      // Scoped by IMPORTER: only the registry path (a window's definition.ts or
      // index.ts barrel) gets the stub. A render test importing its content
      // component directly must receive the real module — the unscoped version
      // silently stubbed UsersWindowContent's own suite into asserting against
      // `() => null` (3 tests red since 2026-06-30, empty DOM, no error).
      name: 'stub-window-content',
      enforce: 'pre',
      resolveId(source, importer) {
        const m = source.match(/(?:^|\/)([A-Za-z]+WindowContent)$/)
        if (!m) return null
        if (!importer || !/[\\/]windows[\\/][A-Za-z]+Window[\\/](definition|index)\.tsx?$/.test(importer)) {
          return null
        }
        return `\0window-content:${m[1]}`
      },
      load(id) {
        if (!id.startsWith('\0window-content:')) return null
        const name = id.slice('\0window-content:'.length)
        return `const Stub = () => null\nexport const ${name} = Stub\nexport default Stub\n`
      },
    },
  ],
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: {
      'react-native': 'react-native-web',
      '@tamagui/lucide-icons': lucideStub,
      'react-native-svg': reactNativeSvgStub,
      'react-native-render-html': renderHtmlStub,
      '@native-html/table-plugin': tablePluginStub,
      'posthog-react-native': posthogStub,
      'react-native-safe-area-context': safeAreaContextStub,
    },
    conditions: ['browser', 'import', 'default'],
  },
  define: {
    'process.env.TAMAGUI_TARGET': JSON.stringify('web'),
    __DEV__: 'true',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.render.test.{ts,tsx}'],
    // Tamagui's first mount per worker is expensive (config init + RN-Web style
    // injection). With many render files running in parallel, that cold start
    // contends for CPU and the default 5s tips the first test of each file over
    // (every overflow seen was a plain timeout, never an assertion). Generous
    // ceiling so cold starts pass while real hangs still fail.
    testTimeout: 20000,
    server: {
      // Tamagui/RN-Web ship untranspiled ESM — let Vite transform them.
      deps: { inline: [/tamagui/, /@tamagui/, /react-native-web/, /@react-native/, /expo/] },
    },
  },
})
