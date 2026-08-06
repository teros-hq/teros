import type { ReactNode } from 'react'

/**
 * Stub for `react-native-render-html` in render tests (TER-461).
 *
 * The package deep-imports Flow-typed source → esbuild chokes on `typeof` and the
 * test fails to collect (same class as react-native-svg / lucide; see
 * reference-harness-render-unblock). It is reached directly by MarkdownContent and
 * transitively by every MCA renderer that renders markdown (so the `mca` barrel —
 * and thus ToolCallBlock — needs it too). Aliased by package name in vitest.config.ts.
 *
 * It doubles as a test seam: `renderHtmlSpy.source` holds the last `source` prop, so
 * MarkdownContent's marked→HTML wiring can be asserted without rendering real HTML.
 */
export const renderHtmlSpy: { source?: { html?: string } } = {}

const RenderHtml = (props: { source?: { html?: string }; children?: ReactNode }) => {
  renderHtmlSpy.source = props.source
  return null
}

export default RenderHtml
