import type { ReactNode } from "react"

/**
 * Stub for `react-native-safe-area-context` in render tests.
 *
 * The package deep-imports Flow-typed native source → esbuild chokes with
 * "Unexpected token 'typeof'" and the suite fails to collect (same class as
 * `react-native-svg` / `@tamagui/lucide-icons`; see the harness notes in
 * vitest.config.ts). Render tests assert structure and text, not real device
 * insets, so the hook returns a zero-inset frame and the providers are no-ops.
 * Aliased by package name in vitest.config.ts so the real graph is never imported.
 *
 * Reached via `McaStatusDashboard` (bottom Sheet padding uses `useSafeAreaInsets`).
 */
const zeroInsets = { top: 0, bottom: 0, left: 0, right: 0 }
const zeroFrame = { x: 0, y: 0, width: 0, height: 0 }

export const useSafeAreaInsets = () => zeroInsets
export const useSafeAreaFrame = () => zeroFrame

const Passthrough = ({ children }: { children?: ReactNode }) => children ?? null

export const SafeAreaProvider = Passthrough
export const SafeAreaView = Passthrough
export const SafeAreaInsetsContext = {
  Provider: Passthrough,
  Consumer: ({ children }: { children?: (v: typeof zeroInsets) => ReactNode }) =>
    typeof children === "function" ? children(zeroInsets) : null,
}
export const SafeAreaFrameContext = {
  Provider: Passthrough,
  Consumer: ({ children }: { children?: (v: typeof zeroFrame) => ReactNode }) =>
    typeof children === "function" ? children(zeroFrame) : null,
}
export const initialWindowMetrics = { insets: zeroInsets, frame: zeroFrame }

export default SafeAreaProvider
