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
// QueuedIndicator's clock (queuedDecorations.render.test):
export const Clock3 = NoopIcon

// Used by the voice surfaces (Voice Mode v2 F5c — orb popover + bar):
export const MicOff = NoopIcon
export const PhoneOff = NoopIcon
// ModePicker's passive-mode icon (lucide, not the mca barrel):
export const Moon = NoopIcon

// Used by the voice thread rows (Voice Mode v2 F3b):
export const Ear = NoopIcon

// Used by VoiceErrorBanner (Voice Mode v2 F3c):
export const ClipboardCopy = NoopIcon
export const LogIn = NoopIcon
export const Phone = NoopIcon
export const Settings2 = NoopIcon

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

// Used by AddProviderForm's provider rows (onboarding render test):
export const Cloud = NoopIcon

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

// Used by the Academy detail view back button (TER-716):
export const ArrowLeft = NoopIcon

// Used by the Academy catalog GRID/LIST toggle (TER-716). `List` and `Play`
// come from iconsStub; only LayoutGrid is missing there.
export const LayoutGrid = NoopIcon

// Used by SkillsWindowContent (TER-618 skills CRUD render tests):
export const BookOpen = NoopIcon
export const Plus = NoopIcon
export const Pencil = NoopIcon
export const Trash2 = NoopIcon
export const Check = NoopIcon
export const X = NoopIcon

// Used by the Automate window (feat/automate-recovery):
export const ArrowDown = NoopIcon
export const ArrowUp = NoopIcon
// Used by the Automate list redesign (badges + group headers):
export const Webhook = NoopIcon
export const Target = NoopIcon
export const SquarePlus = NoopIcon
// Used by the Automate card-grid redesign (2026-10: filters + cards + stats):
export const Zap = NoopIcon
export const Search = NoopIcon
export const SearchX = NoopIcon
export const Link2 = NoopIcon
export const CalendarClock = NoopIcon
export const MessageSquare = NoopIcon
export const Workflow = NoopIcon
export const Activity = NoopIcon
