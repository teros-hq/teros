/**
 * AuthColumns — native no-op. The web variant (`AuthColumns.web.tsx`) paints
 * the prototype's welcome background `TerosBgColumns`: tall round-capped
 * columns of brand colour that rise and fall behind the access card.
 */
export interface AuthColumnsProps {
  /** Page colour under the columns (the theme's `bgPage`). */
  background: string
}

export function AuthColumns(_props: AuthColumnsProps): null {
  return null
}
