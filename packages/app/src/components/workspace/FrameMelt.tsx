/**
 * FrameMelt — native no-op. The web variant (`FrameMelt.web.tsx`) paints the
 * melting boundary between the sidebar frame and the pane sheet.
 */
export interface FrameMeltProps {
  side: "side" | "pane"
  /** Frame colour (`--fr`, the sidebar background). */
  frame: string
  /** Sheet colour (`--sheet`, the pane background). */
  sheet: string
  /** Wave amplitude multiplier (the prototype uses .4 for the mini sidebar). */
  scale?: number
}

export function FrameMelt(_props: FrameMeltProps): null {
  return null
}
