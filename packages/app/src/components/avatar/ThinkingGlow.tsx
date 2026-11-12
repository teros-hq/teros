/**
 * ThinkingGlow — native no-op. The web variant (`ThinkingGlow.web.tsx`)
 * paints an agent's PRESENCE behind its avatar: a quiet violet rim at rest
 * that wakes into the full thinking glow while the agent works. Native keeps
 * the ring.
 */
export interface ThinkingGlowProps {
  /** Avatar size in px — every measure of the glow scales with it. */
  size: number
  /** Working (full glow) or at rest (quiet rim). Transitions are animated. */
  working: boolean
}

export function ThinkingGlow(_props: ThinkingGlowProps): null {
  return null
}
