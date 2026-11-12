/**
 * AccesoTab — every user-modification action for the admin detail drill-in,
 * grouped and gated by the caller's role. Each action opens a ConfirmDialog with
 * explicit consequence copy before it fires.
 *
 * Gating (the security-relevant invariants a mutation test must keep red):
 *  - Rol + Impersonar are SUPER-ONLY (hidden for admins).
 *  - The caller can't change their OWN role or suspend THEMSELVES (self-block).
 *  - A `super` target can't be suspended or impersonated.
 *
 * Backend contract: this tab sends DATA (ids + enum values); it never composes UI
 * strings server-side. The client mutations come from `getTerosClient().admin`;
 * impersonation is delegated up (it must swap the session + reconnect).
 * Presentation: one ds `Card` per group, `Btn` actions, a PTabs-like role track.
 */

import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Btn, type BtnVariant, Card, FieldHelp, Ph, T } from "../../../components/ui/ds"
import type { UserRole, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog } from "./ConfirmDialog"
import { StepUpDialog } from "./StepUpDialog"

type TerosClient = ReturnType<typeof getTerosClient>

type PendingAction =
  | { kind: "role"; role: UserRole }
  | { kind: "suspend" }
  | { kind: "restore" }
  | { kind: "grant" }
  | { kind: "impersonate" }

/** Check whether a caught error is a STEP_UP_REQUIRED from the backend. */
function isStepUpRequired(e: unknown): boolean {
  return (e as Error & { code?: string })?.code === "STEP_UP_REQUIRED"
}

export interface AccesoTabProps {
  user: UserSummary
  /** The CURRENT caller's role (same source as the list — the auth store). */
  callerRole?: UserRole
  callerUserId?: string
  isImpersonating: boolean
  onUpdate: (patch: Partial<UserSummary>) => void
  /** Impersonation must swap the session token + reconnect → owned by the parent. */
  onImpersonate: () => Promise<void>
}

const ROLES: UserRole[] = ["user", "admin", "super"]

/**
 * Run one confirmed action against the backend and return the row patch to apply
 * (null for impersonation, which swaps the whole session). Kept flat (a switch,
 * not an if/else chain) so it stays within the complexity budget.
 */
async function performAction(
  client: TerosClient,
  userId: string,
  pending: PendingAction,
  onImpersonate: () => Promise<void>,
): Promise<Partial<UserSummary> | null> {
  switch (pending.kind) {
    case "role":
      await client.admin.updateUserRole(userId, pending.role)
      return { role: pending.role }
    case "suspend":
      await client.admin.updateUserStatus(userId, "suspended")
      return { status: "suspended" }
    case "restore":
      await client.admin.updateUserStatus(userId, "active")
      return { status: "active" }
    case "grant":
      await client.admin.grantAccess(userId)
      return { accessGranted: true }
    case "impersonate":
      await onImpersonate()
      return null
  }
}

export function AccesoTab({
  user,
  callerRole,
  callerUserId,
  isImpersonating,
  onUpdate,
  onImpersonate,
}: AccesoTabProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const [pending, setPending] = useState<PendingAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Step-up auth state: when a STEP_UP_REQUIRED error is received, we show the
  // StepUpDialog. After successful re-authentication, we retry the original action.
  const [stepUpOpen, setStepUpOpen] = useState(false)
  // The pending action that needs step-up — kept so we can retry after verify.
  const [stepUpPending, setStepUpPending] = useState<PendingAction | null>(null)
  // Whether the current caller has MFA enabled. We don't always know this from
  // the user summary, so we default to false (password path). The backend will
  // return MFA_REQUIRED if MFA is enabled, and the dialog will adapt on retry.
  const [callerMfaEnabled, setCallerMfaEnabled] = useState(false)

  const isSuper = callerRole === "super"
  const isSelf = callerUserId != null && callerUserId === user.userId
  const targetIsSuper = user.role === "super"

  const name =
    user.profile.displayName ?? user.profile.email ?? t("windows.usersPanel.detail.thisUser")

  const runPending = async () => {
    if (!pending) return
    setBusy(true)
    setActionError(null)
    try {
      const patch = await performAction(client, user.userId, pending, onImpersonate)
      if (patch) onUpdate(patch)
      setPending(null)
    } catch (e) {
      if (isStepUpRequired(e)) {
        // Try auto-verification first (OAuth-only users get auto-approved
        // by the backend with no password/MFA). If it fails, show the dialog.
        try {
          await client.admin.verifyStepUp({})
          // Auto-verification succeeded — retry the original action immediately.
          const patch = await performAction(client, user.userId, pending, onImpersonate)
          if (patch) onUpdate(patch)
          setPending(null)
        } catch (stepUpErr) {
          // Auto-verification failed — the user has a password or MFA.
          // Adapt the dialog based on the error code.
          const suErr = stepUpErr as Error & { code?: string }
          if (suErr.code === "MFA_REQUIRED") setCallerMfaEnabled(true)
          setStepUpPending(pending)
          setStepUpOpen(true)
          setPending(null)
        }
      } else {
        // Check if the error indicates MFA is required (helps us adapt the dialog)
        const err = e as Error & { code?: string }
        if (err.code === "MFA_REQUIRED") {
          setCallerMfaEnabled(true)
        }
        setActionError(
          (e as { message?: string })?.message ?? t("windows.usersPanel.actions.actionFailed"),
        )
        setPending(null)
      }
    } finally {
      setBusy(false)
    }
  }

  // After successful step-up verification, retry the original action.
  const handleStepUpSuccess = async () => {
    setStepUpOpen(false)
    if (!stepUpPending) return
    setBusy(true)
    setActionError(null)
    try {
      const patch = await performAction(client, user.userId, stepUpPending, onImpersonate)
      if (patch) onUpdate(patch)
    } catch (e) {
      // If step-up expired or something else went wrong, show the error.
      setActionError(
        (e as { message?: string })?.message ?? t("windows.usersPanel.actions.actionFailed"),
      )
    } finally {
      setStepUpPending(null)
      setBusy(false)
    }
  }

  const handleStepUpCancel = () => {
    setStepUpOpen(false)
    setStepUpPending(null)
  }

  const dc = dialogCopy(pending, name, t)

  return (
    <View style={{ gap: 12 }}>
      {actionError ? <ActionErrorBanner message={actionError} /> : null}

      {isSuper ? (
        <RoleGroup
          user={user}
          isSelf={isSelf}
          onSelect={(role) => setPending({ kind: "role", role })}
        />
      ) : null}

      <StatusGroup
        user={user}
        isSelf={isSelf}
        targetIsSuper={targetIsSuper}
        onSuspend={() => setPending({ kind: "suspend" })}
        onRestore={() => setPending({ kind: "restore" })}
      />

      {!user.accessGranted ? <WaitlistGroup onGrant={() => setPending({ kind: "grant" })} /> : null}

      {isSuper ? (
        <SessionGroup
          isImpersonating={isImpersonating}
          blocked={targetIsSuper || isSelf}
          onImpersonate={() => setPending({ kind: "impersonate" })}
        />
      ) : null}

      <ConfirmDialog
        open={pending != null}
        title={dc.title}
        body={dc.body}
        confirmLabel={dc.confirmLabel}
        cancelLabel={t("windows.usersPanel.actions.cancel")}
        tone={dc.tone}
        busy={busy}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />

      <StepUpDialog
        open={stepUpOpen}
        mfaEnabled={callerMfaEnabled}
        onSuccess={handleStepUpSuccess}
        onCancel={handleStepUpCancel}
      />
    </View>
  )
}

// ─── Copy resolver (data → localized consequence strings) ──────────────────────

function dialogCopy(
  pending: PendingAction | null,
  name: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): { title: string; body: string; confirmLabel: string; tone: "default" | "danger" } {
  const kind = pending?.kind ?? "suspend"
  const roleLabel = pending?.kind === "role" ? t(`windows.usersPanel.role.${pending.role}`) : ""
  return {
    title: t(`windows.usersPanel.actions.confirm.${kind}.title`, { name }),
    body: t(`windows.usersPanel.actions.confirm.${kind}.body`, { name, role: roleLabel }),
    confirmLabel: t(`windows.usersPanel.actions.confirm.${kind}.confirm`),
    tone: kind === "suspend" ? "danger" : "default",
  }
}

// ─── Action groups (one section each) ──────────────────────────────────────────

function RoleGroup({
  user,
  isSelf,
  onSelect,
}: {
  user: UserSummary
  isSelf: boolean
  onSelect: (role: UserRole) => void
}) {
  const { t } = useTranslation()
  return (
    <ActionGroup icon="shield-check" title={t("windows.usersPanel.actions.sectionRole")}>
      <RoleSelector current={user.role} disabled={isSelf} onSelect={onSelect} />
      {isSelf ? <Hint text={t("windows.usersPanel.actions.blockedSelf")} /> : null}
    </ActionGroup>
  )
}

function StatusGroup({
  user,
  isSelf,
  targetIsSuper,
  onSuspend,
  onRestore,
}: {
  user: UserSummary
  isSelf: boolean
  targetIsSuper: boolean
  onSuspend: () => void
  onRestore: () => void
}) {
  const { t } = useTranslation()
  const isSuspended = user.status === "suspended"
  return (
    <ActionGroup
      icon={isSuspended ? "power" : "prohibit"}
      title={t("windows.usersPanel.actions.sectionStatus")}
    >
      {isSuspended ? (
        <ActionButton
          testID="acceso-restore"
          icon="power"
          label={t("windows.usersPanel.actions.restore")}
          onPress={onRestore}
          disabled={isSelf || targetIsSuper}
        />
      ) : (
        <ActionButton
          testID="acceso-suspend"
          icon="prohibit"
          label={t("windows.usersPanel.actions.suspend")}
          tone="danger"
          onPress={onSuspend}
          disabled={isSelf || targetIsSuper}
        />
      )}
      {isSelf ? <Hint text={t("windows.usersPanel.actions.blockedSelf")} /> : null}
      {!isSelf && targetIsSuper ? (
        <Hint text={t("windows.usersPanel.actions.blockedSuper")} />
      ) : null}
    </ActionGroup>
  )
}

function WaitlistGroup({ onGrant }: { onGrant: () => void }) {
  const { t } = useTranslation()
  return (
    <ActionGroup icon="user-plus" title={t("windows.usersPanel.actions.sectionWaitlist")}>
      <ActionButton
        testID="acceso-grant"
        icon="check"
        label={t("windows.usersPanel.actions.grant")}
        tone="positive"
        onPress={onGrant}
      />
    </ActionGroup>
  )
}

function SessionGroup({
  isImpersonating,
  blocked,
  onImpersonate,
}: {
  isImpersonating: boolean
  blocked: boolean
  onImpersonate: () => void
}) {
  const { t } = useTranslation()
  return (
    <ActionGroup icon="arrows-left-right" title={t("windows.usersPanel.actions.sectionSession")}>
      <ActionButton
        testID="acceso-impersonate"
        icon="user-switch"
        label={
          isImpersonating
            ? t("windows.usersPanel.actions.impersonating")
            : t("windows.usersPanel.actions.impersonate")
        }
        onPress={onImpersonate}
        disabled={blocked || isImpersonating}
      />
      {blocked ? <Hint text={t("windows.usersPanel.actions.impersonateBlocked")} /> : null}
    </ActionGroup>
  )
}

// ─── Presentational primitives ─────────────────────────────────────────────────

function ActionErrorBanner({ message }: { message: string }) {
  const c = useColors()
  return (
    <View
      testID="acceso-error"
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
        backgroundColor: c.tint.r.bg,
      }}
    >
      <T step="sm" color={c.tint.r.tx} numberOfLines={2}>
        {message}
      </T>
    </View>
  )
}

/** One group = one card: Phosphor glyph + uppercase label, then the controls. */
function ActionGroup({
  icon,
  title,
  children,
}: {
  icon: string
  title: string
  children: ReactNode
}) {
  const c = useColors()
  return (
    <Card pad>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Ph name={icon} size={14} color={c.text3} />
        <T step="xs" tone="text2">
          {title}
        </T>
      </View>
      <View style={{ gap: 10, alignItems: "flex-start" }}>{children}</View>
    </Card>
  )
}

/** The role picker: a PTabs-like washed track with `aria-pressed` options. */
function RoleSelector({
  current,
  disabled,
  onSelect,
}: {
  current: UserRole
  disabled: boolean
  onSelect: (role: UserRole) => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <View
      testID="acceso-role-group"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        padding: 4,
        borderRadius: 10,
        backgroundColor: c.wash,
        alignSelf: "flex-start",
        opacity: disabled ? 0.5 : 1,
      }}
      {...({ role: "group" } as Record<string, unknown>)}
    >
      {ROLES.map((r) => (
        <RoleOption
          key={r}
          role={r}
          active={r === current}
          disabled={disabled}
          label={t(`windows.usersPanel.role.${r}`)}
          onSelect={onSelect}
        />
      ))}
    </View>
  )
}

function RoleOption({
  role,
  active,
  disabled,
  label,
  onSelect,
}: {
  role: UserRole
  active: boolean
  disabled: boolean
  label: string
  onSelect: (role: UserRole) => void
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  const interactive = !disabled && !active
  return (
    <Pressable
      testID={`acceso-role-${role}`}
      disabled={disabled}
      onPress={interactive ? () => onSelect(role) : undefined}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      {...({
        role: "button",
        tabIndex: interactive ? 0 : -1,
        "aria-pressed": active,
        "aria-disabled": disabled,
      } as Record<string, unknown>)}
      style={[
        {
          height: 32,
          paddingHorizontal: 14,
          borderRadius: 8,
          justifyContent: "center",
          backgroundColor: active ? c.bgStep : hover && interactive ? c.wash2 : "transparent",
        },
        Platform.OS === "web"
          ? ({
              cursor: interactive ? "pointer" : "default",
              transition: "background 0.25s, box-shadow 0.25s",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
            } as any)
          : null,
      ]}
    >
      <T step="sm" color={active ? c.accent : c.text2}>
        {label}
      </T>
    </Pressable>
  )
}

const TONE_VARIANT: Record<"default" | "danger" | "positive", BtnVariant> = {
  default: "sec",
  danger: "dangerSoft",
  positive: "mint",
}

function ActionButton({
  testID,
  icon,
  label,
  onPress,
  tone = "default",
  disabled = false,
}: {
  testID: string
  icon?: string
  label: string
  onPress: () => void
  tone?: "default" | "danger" | "positive"
  disabled?: boolean
}) {
  return (
    <Btn
      testID={testID}
      variant={TONE_VARIANT[tone]}
      icon={icon}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      {...({ "aria-disabled": disabled } as Record<string, unknown>)}
    >
      {label}
    </Btn>
  )
}

function Hint({ text }: { text: string }) {
  return <FieldHelp style={{ marginTop: 0 }}>{text}</FieldHelp>
}
