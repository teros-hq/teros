/**
 * Halo — native no-op. The web variant (`Halo.web.tsx`) paints the prototype's
 * button halo: a blurred bloom of the pill's own colour that wanders under the
 * pointer while the button is hovered.
 */
export type HaloSize = "sm" | "md" | "lg" | "xl"

export interface HaloProps {
  /** The pill colour — the halo is the same colour, bloomed outside the pill. */
  color: string
  /** Scale of the bloom: sm 28px · md 36px · lg 44px · xl 48px+ controls. */
  size?: HaloSize
  /** Corner radius of the pill the bloom is cast from (100 = full pill). */
  radius?: number
  /** Disabled buttons carry no halo. */
  disabled?: boolean
}

export function Halo(_props: HaloProps): null {
  return null
}
