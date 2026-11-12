/**
 * Teros OS design primitives — the component vocabulary of the OS prototype
 * (design-testing, Oct 2026). Everything reads `useColors()` so it follows the
 * active theme; all weights are 400; fonts are Saans / Prody / Reddit Mono;
 * icons are Phosphor by kebab-case name.
 */
export { Ph } from "./Icon"
export { WorkingDot } from "./WorkingDot"
export type { PhProps, PhWeight } from "./Icon.types"
export { T, Headline, STEP_STYLES } from "./Text"
export type { TProps, TextStep, TextTone } from "./Text"
export { Btn, IconBtn, ChipBtn, Chip, InkToggle } from "./Buttons"
export { Halo } from "./Halo"
export type { HaloProps, HaloSize } from "./Halo"
export type { BtnProps, BtnVariant, BtnSize, IconBtnProps, ChipProps } from "./Buttons"
export { Badge, Dot, CountPill, Kbd } from "./Badge"
export type { BadgeProps, BadgeTone } from "./Badge"
export { Card, LGroup, LRow, Stats, Stat, DangerZone } from "./Card"
export type { CardProps, LRowProps } from "./Card"
export {
  Page,
  PageHead,
  SectionLabel,
  SecH,
  Grid,
  EmptyHint,
  EmptyState,
  PHead,
  usePagePadding,
} from "./Page"
export {
  Field,
  FieldLabel,
  FieldHelp,
  FieldGroup,
  SelectField,
  Switch,
  Radio,
  Check,
  OptionRow,
} from "./Field"
export type { FieldProps } from "./Field"
export { PTabs, Segmented } from "./Tabs"
export type { PTabItem, PTabsProps } from "./Tabs"
export { Tile } from "./Tile"
export type { TileTone, TileSize } from "./Tile"
