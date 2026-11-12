/**
 * Permission Controls Context — Renderer UX Guide v2 §8.
 *
 * Coordinates `withPermissionSupport` (provider) with `ToolCallCard`
 * (consumer). When the wrapped tool call enters `pending_permission`,
 * the HOC provides:
 *   • permissionRequestId, appId, toolName — identify the pending request.
 *   • forceExpand — tells the card to render expanded by default
 *     regardless of its own `defaultExpanded` prop.
 *   • detail — the `<PermissionDetail/>` element to render at the end of
 *     the card body, BELOW whatever the renderer itself contributed.
 *   • claimDetailSlot — how the card tells the HOC it took the detail.
 *
 * The card reads this context inside its render and, if a request is
 * active, automatically:
 *   • opens its body (forceExpand),
 *   • appends `detail` to its body,
 *   • claims the detail slot so the HOC does not ALSO render it as a
 *     sibling below the card.
 *
 * This keeps individual renderers ignorant of the permission flow —
 * they don't need to import PermissionDetail or thread permission props.
 *
 * The Allow/Deny `ControlsBar` is NOT part of this: the HOC renders it
 * directly as a sibling beneath the card, so that collapsing the card
 * cannot hide the decision the user has to make. See withPermissionSupport.
 *
 * ── Two contracts that are invisible from the types ───────────────────
 *
 * 1. `claimDetailSlot` MUST be referentially stable (`useCallback(…, [])`).
 *    The card uses it as an effect dependency; an unstable identity turns
 *    claim → setState → new identity into an infinite effect loop.
 *
 * 2. The fallback depends on React flushing CHILD passive effects before
 *    PARENT ones. The card (child) claims during its effect; the HOC
 *    (parent) checks the claim count in its own effect, which therefore
 *    runs afterwards. Do not convert one side to `useLayoutEffect`
 *    without the other — that inverts the ordering and the HOC would
 *    render a duplicate detail below every card.
 */

import { createContext, useContext } from 'react';

export interface PermissionControlsValue {
  permissionRequestId: string;
  appId?: string;
  toolName: string;
  /** Force the card to render with body expanded. */
  forceExpand: boolean;
  /**
   * The approval detail to render at the end of the card body. Always set
   * while a request is pending: a batch is a frame around real cards, every
   * card keeps its own detail (PERMW-REQ-3).
   */
  detail: React.ReactNode;
  /**
   * Called by the card that renders `detail`, so the HOC knows a card took
   * it and suppresses its own sibling fallback. Returns a release function;
   * call it on unmount. MUST be referentially stable — see contract 1 above.
   */
  claimDetailSlot: () => () => void;
}

export const PermissionControlsContext = createContext<PermissionControlsValue | null>(null);

/** `null` when no active permission request — most renderings. */
export function usePermissionControls(): PermissionControlsValue | null {
  return useContext(PermissionControlsContext);
}
