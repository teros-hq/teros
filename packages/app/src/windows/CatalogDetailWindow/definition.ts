/**
 * Catalog Detail Window Type Definition (TER-526)
 *
 * Pre-install detail view of a single MCA (docs/mcas/catalog-detail-*.html).
 * Opened from a catalog card. Deduped per mcaId so re-clicking focuses the
 * existing window instead of stacking duplicates.
 */

import { Store } from '@tamagui/lucide-icons'
import type { WindowTypeDefinition } from '../../services/windowRegistry'
import { CatalogDetailWindowContent } from './CatalogDetailWindowContent'

export interface CatalogDetailWindowProps {
  /** MCA to show */
  mcaId: string
  /** Workspace context for install */
  workspaceId?: string
}

// A few segments that read better with custom casing than naive capitalisation.
const SEGMENT_CASING: Record<string, string> = { ai: 'AI', api: 'API' }

/**
 * Tab title from an mcaId: `mca.google.calendar` → "Google Calendar".
 * getTitle is sync (props only, no loaded detail), so we normalise the slug —
 * strip the `mca.` prefix, split on separators and title-case each segment.
 */
function titleFromMcaId(mcaId?: string): string {
  if (!mcaId) return 'Agent App'
  const words = mcaId
    .replace(/^mca\./, '')
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((seg) => SEGMENT_CASING[seg.toLowerCase()] ?? seg.charAt(0).toUpperCase() + seg.slice(1))
  return words.length ? words.join(' ') : 'Agent App'
}

export const catalogDetailWindowDefinition: WindowTypeDefinition<CatalogDetailWindowProps> = {
  type: 'catalog-detail',
  displayName: 'Agent App Detail',
  icon: Store,
  color: '#5E6AD2',
  component: CatalogDetailWindowContent,

  defaultSize: { width: 760, height: 800 },
  minSize: { width: 480, height: 520 },

  // One window per MCA — re-clicking a card focuses the open detail.
  getKey: (props) => `catalog-detail:${props.mcaId}`,

  getTitle: (props) => titleFromMcaId(props?.mcaId),

  serialize: (props) => ({ mcaId: props.mcaId, workspaceId: props.workspaceId }),
  deserialize: (data) => ({
    mcaId: data.mcaId as string,
    workspaceId: data.workspaceId as string | undefined,
  }),
}
