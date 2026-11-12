import type { ReactNode } from 'react'

/**
 * Stub for `react-native-webview` in render tests.
 *
 * The package ships Flow-typed native source that esbuild cannot parse
 * (same class as react-native-svg, react-native-render-html, etc.).
 * Reached transitively via MarkdownContent (table plugin) and HtmlBubble.
 * Aliased by package name in vitest.config.ts.
 */
const WebView = (props: { children?: ReactNode }) => {
  return null
}

export default WebView
