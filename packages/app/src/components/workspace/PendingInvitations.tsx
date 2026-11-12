/**
 * PendingInvitations — MUW-14 Fase 2: explicit invitation acceptance.
 *
 * Two presentations of one flow (Pablo, 2026-10-27): every invitation creates
 * a pending entry; the invitee accepts or declines in the app — only then does
 * the membership become active.
 *
 *   <PendingInvitationsScreen /> — full screen. Shown by the RootResolver when
 *   the app opens with ?invite_email=...&invite_token=... (the email CTA):
 *   "You've been invited to X" with Accept / Decline, plus a clear message
 *   when the token is invalid (revoked, declined, already accepted).
 *
 *   <PendingInvitationsBanner /> — full-width strip for authenticated users
 *   whose email has pending invitations that did NOT come from the URL
 *   (invited-with-account, or the signup happened after the invite).
 *   Accept / Decline inline.
 *
 * Identity model (backend): the wire carries ONLY the token; the backend
 * resolves the account's email server-side and matches it against the invited
 * email. A leaked token alone can never grant membership.
 *
 * After a successful accept, the backend broadcasts `workspace.created` to the
 * accepter so the Navbar workspace list live-refreshes (addWorkspace is
 * upsert-safe).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { AppSpinner } from "../ui/AppSpinner"
import { EditorialScreen } from "../ui/EditorialScreen"
import { Btn, IconBtn, Ph, T } from "../ui/ds"
import { useColors } from "../mca/primitives/useColors"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { PendingInvitation } from "../../services/WorkspaceApi"

// ----------------------------------------------------------------------------
// Shared accept/decline logic
// ----------------------------------------------------------------------------

type Decision = "accept" | "decline"

interface DecisionState {
  busy: boolean
  /** Set when the backend rejected the accept/decline (e.g. invalid token). */
  error: "not-found" | "mismatch" | "generic" | null
  /** Set after a successful decision — the invitation is resolved. */
  done: "accepted" | "declined" | null
}

const INITIAL_STATE: DecisionState = { busy: false, error: null, done: null }

/** Shared accept/decline call — token-only wire, identity resolved server-side. */
async function decide(token: string, action: Decision): Promise<DecisionState> {
  const client = getTerosClient()
  try {
    if (action === "accept") {
      await client.workspace.acceptInvitation({ inviteToken: token })
      return { busy: false, error: null, done: "accepted" }
    }
    await client.workspace.declineInvitation({ inviteToken: token })
    return { busy: false, error: null, done: "declined" }
  } catch (e: any) {
    const code = String(e?.code ?? e?.errorCode ?? e?.message ?? "")
    if (code.includes("INVITATION_NOT_FOUND")) {
      return { busy: false, error: "not-found", done: null }
    }
    if (code.includes("INVITATION_EMAIL_MISMATCH")) {
      return { busy: false, error: "mismatch", done: null }
    }
    return { busy: false, error: "generic", done: null }
  }
}

/** i18n key for a decision error — shared by both presentations. */
export function inviteErrorKey(error: NonNullable<DecisionState["error"]>): string {
  switch (error) {
    case "not-found":
      return "invitations.errorNotFound"
    case "mismatch":
      return "invitations.errorMismatch"
    default:
      return "invitations.errorGeneric"
  }
}

// ----------------------------------------------------------------------------
// Screen (email CTA: ?invite_email=...&invite_token=...)
// ----------------------------------------------------------------------------

export function PendingInvitationsScreen({
  inviteEmail,
  inviteToken,
  onDone,
}: {
  inviteEmail: string
  inviteToken: string
  /** Called after the invitation is resolved (accepted, declined, or invalid)
   *  — the caller continues the normal root resolution. */
  onDone: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [state, setState] = useState<DecisionState>(INITIAL_STATE)

  const handle = useCallback(
    async (action: Decision) => {
      if (state.busy || state.done) return
      setState((s) => ({ ...s, busy: true, error: null }))
      const result = await decide(inviteToken, action)
      setState(result)
      // After a successful decision, continue into the app after a beat so
      // the confirmation is visible.
      if (result.done) {
        setTimeout(onDone, 900)
      }
    },
    [inviteToken, onDone, state.busy, state.done],
  )

  if (state.done) {
    return (
      <EditorialScreen
        title={t(state.done === "accepted" ? "invitations.acceptedTitle" : "invitations.declinedTitle")}
        description={t(
          state.done === "accepted"
            ? "invitations.acceptedDescription"
            : "invitations.declinedDescription",
        )}
        actionLabel={t("invitations.continue")}
        onAction={onDone}
      />
    )
  }

  if (state.error) {
    // Token invalid / revoked / already accepted / email mismatch — a clear
    // message, with a way into the app anyway.
    return (
      <EditorialScreen
        title={t("invitations.errorTitle")}
        description={t(inviteErrorKey(state.error))}
        actionLabel={t("invitations.continue")}
        onAction={onDone}
      />
    )
  }

  return (
    <View
      testID="pending-invitations-screen"
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: c.bgPage,
        padding: 24,
      }}
    >
      <View style={{ maxWidth: 440, width: "100%", gap: 10 }}>
        <Ph name="envelope-open" size={40} color={c.tint.a.tx} />
        <T step="xl">{t("invitations.screenTitle")}</T>
        <T step="sm" tone="text2" style={{ lineHeight: 19 }}>
          {t("invitations.screenDescription", { email: inviteEmail })}
        </T>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
          <Btn
            testID="invite-accept-btn"
            variant="primary"
            size="lg"
            icon="check"
            disabled={state.busy}
            onPress={() => handle("accept")}
          >
            {t("invitations.accept")}
          </Btn>
          <Btn
            testID="invite-decline-btn"
            variant="sec"
            size="lg"
            disabled={state.busy}
            onPress={() => handle("decline")}
          >
            {t("invitations.decline")}
          </Btn>
        </View>
        {state.busy ? (
          <View style={{ marginTop: 14, alignItems: "center" }}>
            <AppSpinner size="sm" variant="default" />
          </View>
        ) : null}
      </View>
    </View>
  )
}

// ----------------------------------------------------------------------------
// Banner (authenticated user with pending invitations)
// ----------------------------------------------------------------------------

export function PendingInvitationsBanner() {
  const { t } = useTranslation()
  const c = useColors()
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<NonNullable<DecisionState["error"]> | null>(null)

  const load = useCallback(() => {
    const client = getTerosClient()
    client.workspace
      .listInvitations()
      .then(({ invitations }) => {
        setInvitations(invitations)
      })
      .catch(() => {
        // Best-effort: a failed lookup just means no banner.
        setInvitations([])
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const resolve = async (invitation: PendingInvitation, action: Decision) => {
    if (busyId) return
    setBusyId(invitation.workspaceId)
    setError(null)
    const result = await decide(invitation.inviteToken, action)
    if (result.done) {
      setInvitations((prev) =>
        (prev ?? []).filter((i) => i.workspaceId !== invitation.workspaceId),
      )
    } else if (result.error) {
      setError(result.error)
      // The listed invitation is stale — reload the source of truth.
      load()
    }
    setBusyId(null)
  }

  if (!invitations || invitations.length === 0) return null

  const tint = c.tint.a

  return (
    <View
      testID="pending-invitations-banner"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: tint.bg,
        borderBottomWidth: 1,
        borderBottomColor: tint.bd,
      }}
    >
      <Ph name="envelope-open" size={16} color={tint.tx} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        {invitations.map((inv) => (
          <T key={inv.workspaceId} step="sm">
            {t("invitations.bannerTitle", {
              workspace: inv.workspaceName,
              inviter: inv.invitedBy,
            })}
          </T>
        ))}
        {error ? (
          <T testID="invite-banner-error" step="12" tone="text2">
            {t(inviteErrorKey(error))}
          </T>
        ) : null}
      </View>
      {invitations.length === 1 ? (
        <>
          <Btn
            testID="invite-banner-accept"
            size="sm"
            variant="primary"
            icon="check"
            disabled={busyId === invitations[0].workspaceId}
            onPress={() => resolve(invitations[0], "accept")}
          >
            {t("invitations.accept")}
          </Btn>
          <IconBtn
            icon="x"
            plain
            accessibilityLabel={t("invitations.decline")}
            disabled={busyId === invitations[0].workspaceId}
            onPress={() => resolve(invitations[0], "decline")}
          />
        </>
      ) : null}
    </View>
  )
}
