import type { ReactNode } from 'react'

/**
 * Stub for `react-native-svg` in render tests (TER-461).
 *
 * The package's transpiled `lib/module` entry re-exports a graph that deep-imports
 * Flow-typed source → esbuild chokes with "Unexpected token 'typeof'" and the test
 * fails to collect (same class as @tamagui/lucide-icons; see
 * reference-harness-render-unblock). Since render tests assert structure and text,
 * not SVG geometry, every primitive is a no-op. Aliased by package name in
 * vitest.config.ts so the real graph is never imported.
 *
 * Reached via `TerosLoading` (the loading spinner) → Voice/Audio bubbles and any
 * component drawing inline SVG.
 */
const Noop = (_props: { children?: ReactNode }) => null

export const Svg = Noop
export const Circle = Noop
export const Ellipse = Noop
export const G = Noop
export const Line = Noop
export const Path = Noop
export const Polygon = Noop
export const Polyline = Noop
export const Rect = Noop
export const Text = Noop
export const TSpan = Noop
export const TextPath = Noop
export const Defs = Noop
export const Use = Noop
export const LinearGradient = Noop
export const RadialGradient = Noop
export const Stop = Noop
export const ClipPath = Noop
export const Mask = Noop
export const Pattern = Noop
export const Image = Noop
export const Marker = Noop
export const ForeignObject = Noop

export default Svg
