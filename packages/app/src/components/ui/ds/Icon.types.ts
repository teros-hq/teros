import type { StyleProp, ViewStyle } from "react-native"

export type PhWeight = "regular" | "bold" | "fill"

export interface PhProps {
  /** Phosphor icon name in kebab-case, e.g. `magnifying-glass`. */
  name: string
  size?: number
  color?: string
  weight?: PhWeight
  style?: StyleProp<ViewStyle>
}
