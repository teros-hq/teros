/**
 * Invite URL params — MUW-14 Fase 2 (explicit invitation acceptance).
 *
 * The invitation email CTA opens `os.teros.ai/?invite_email=...&invite_token=...`.
 * The (workspace) group's auth guard redirects to login WITHOUT preserving
 * query params, and the group layout renders a splash (children not mounted)
 * until the session is hydrated — so the params must be captured at the top
 * of the (workspace) layout, on mount, before any redirect can drop them.
 *
 * Flow:
 *   1. `captureInviteParams()` (layout mount) — reads the URL, stashes the
 *      pair in sessionStorage, cleans the URL (a reload must not replay the
 *      invite).
 *   2. Login/signup happens (email can be prefilled via `peekInviteParams`).
 *   3. Back on "/", the RootResolver peeks the stash and renders the
 *      Accept/Decline screen instead of resolving.
 *   4. `consumeInviteParams()` (RootResolver, after the invite is resolved —
 *      accepted, declined, or invalid) — one-shot remove; normal resolution
 *      continues.
 *
 * Web-only by nature (URL params); native builds no-op.
 */

import { Platform } from "react-native"

const STORAGE_KEY = "teros_pending_invite"

export interface InviteParams {
  inviteEmail: string
  inviteToken: string
}

/**
 * Stash `?invite_email=&invite_token=` from the URL into sessionStorage and
 * clean the URL. Idempotent: no params → no-op. Safe to call repeatedly.
 */
export function captureInviteParams(): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return
  const params = new URLSearchParams(window.location.search)
  const inviteEmail = params.get("invite_email")
  const inviteToken = params.get("invite_token")
  if (!inviteEmail || !inviteToken) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ inviteEmail, inviteToken }))
  } catch {
    // Storage unavailable (private mode/quota) — ignore: worst case the invite
    // is still reachable through the pending-invitations banner after login.
  }
  // Clean the URL so a reload does not replay the invite flow.
  params.delete("invite_email")
  params.delete("invite_token")
  const q = params.toString()
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`,
  )
}

/** Read the stashed invite without removing it (e.g. signup prefill). */
export function peekInviteParams(): InviteParams | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<InviteParams> | null
    if (parsed?.inviteEmail && parsed?.inviteToken) {
      return { inviteEmail: parsed.inviteEmail, inviteToken: parsed.inviteToken }
    }
  } catch {
    // Corrupted entry — treat as no invite (it will be overwritten by the
    // next capture or ignored; never crash the app over a stash read).
  }
  return null
}

/** Read and remove the stash — one-shot, called once the invite is resolved. */
export function consumeInviteParams(): InviteParams | null {
  const params = peekInviteParams()
  if (params && Platform.OS === "web" && typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // Removal failed — the peek above still gates the flow; a stale entry
      // is overwritten by the next captureInviteParams with real params.
    }
  }
  return params
}
