// Test stub for `@tamagui/lucide-icons` (render harness, TER-385/TER-461).
//
// ~140 bubble/chat components import icons straight from `@tamagui/lucide-icons`,
// which is Flow-typed — esbuild can't transpile it and a Proxy `vi.mock` hangs the
// jsdom worker (see reference-harness-render-unblock). We alias the package to this
// enumerated stub in vitest.config.ts so every icon resolves to a no-op component.
//
// Superset strategy: re-export the MCA icon barrel stub (~130 names) and add the
// few lucide names the chat bubbles use that it lacks. If a render test fails with
// `No "<Icon>" export is defined`, add that name here.
import type { ComponentType } from 'react'

type IconProps = { size?: number; color?: string; strokeWidth?: number }
const NoopIcon: ComponentType<IconProps> = () => null

export * from './iconsStub'

// Names used by chat bubbles not present in iconsStub.tsx:
export const Mic = NoopIcon
export const Minimize2 = NoopIcon

// Names used by the Session Trace window (F2 / TER-643):
export const AlertTriangle = NoopIcon
export const ChevronDown = NoopIcon
export const CornerDownRight = NoopIcon
export const Wrench = NoopIcon

// Monitoring suite icons.
export const ArrowRight = NoopIcon
export const Loader = NoopIcon
export const DollarSign = NoopIcon
export const Gauge = NoopIcon
export const BarChart3 = NoopIcon
export const TrendingUp = NoopIcon

// Used by the UsersWindow pagination (iconsStub only has ChevronRight):
export const ChevronLeft = NoopIcon

// Used by the Providers window (ProviderCard expanded state):
export const ChevronUp = NoopIcon
export const Key = NoopIcon
export const Loader2 = NoopIcon

// Names used by the MCA Status dashboard (Phase 3) not present in iconsStub.tsx:
export const Package = NoopIcon

// Names used by the redesigned Health window (Phase 4) not present in iconsStub.tsx:
export const EyeOff = NoopIcon

// Used by the real McasWindowContent (Management tab) mounted under the tab-bar
// render harness. The window-content stub is importer-scoped (only stubs when
// imported from a window's definition/index), so this render test mounts the real
// component and needs its lucide icons enumerated here.
export const Eye = NoopIcon
export const Save = NoopIcon
export const Unlock = NoopIcon
