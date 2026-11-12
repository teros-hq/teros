/** HeroDrift — native no-op; the web variant paints the prototype's drift canvas. */
export interface HeroDriftProps {
  /** Page background the colour drifts over (`bgPage` in the prototype). */
  bg: string
  /** Blob diameter in px (prototype hero: 380). */
  size?: number
  /** How far the blob wanders, as a fraction of the box (prototype hero: .8). */
  wander?: number
}

export function HeroDrift(_props: HeroDriftProps): null {
  return null
}
