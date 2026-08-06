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
 */

import { ArrowRightLeft, Power, PowerOff, Shield, UserPlus } from "@tamagui/lucide-icons"
import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"
import type { UserRole, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog } from "./ConfirmDialog"

type TerosClient = ReturnType<typeof getTerosClient>

type PendingAction =
  | { kind: "role"; role: UserRole }
  | { kind: "suspend" }
  | { kind: "restore" }
  | { kind: "grant" }
  | { kind: "impersonate" }

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
      setActionError(
        (e as { message?: string })?.message ?? t("windows.usersPanel.actions.actionFailed"),
      )
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const dc = dialogCopy(pending, name, t)

  return (
    <YStack gap={18} paddingTop={4}>
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
    </YStack>
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
    <ActionGroup
      icon={<Shield size={14} color={tokens.textTertiary} />}
      title={t("windows.usersPanel.actions.sectionRole")}
    >
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
      icon={
        isSuspended ? (
          <Power size={14} color={tokens.textTertiary} />
        ) : (
          <PowerOff size={14} color={tokens.textTertiary} />
        )
      }
      title={t("windows.usersPanel.actions.sectionStatus")}
    >
      {isSuspended ? (
        <ActionButton
          testID="acceso-restore"
          label={t("windows.usersPanel.actions.restore")}
          onPress={onRestore}
          disabled={isSelf || targetIsSuper}
        />
      ) : (
        <ActionButton
          testID="acceso-suspend"
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
    <ActionGroup
      icon={<UserPlus size={14} color={tokens.textTertiary} />}
      title={t("windows.usersPanel.actions.sectionWaitlist")}
    >
      <ActionButton
        testID="acceso-grant"
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
    <ActionGroup
      icon={<ArrowRightLeft size={14} color={tokens.textTertiary} />}
      title={t("windows.usersPanel.actions.sectionSession")}
    >
      <ActionButton
        testID="acceso-impersonate"
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
  return (
    <XStack
      testID="acceso-error"
      paddingHorizontal={12}
      paddingVertical={9}
      borderRadius={10}
      borderWidth={1}
      borderColor={`${tokens.error}38`}
      backgroundColor={`${tokens.error}1A`}
    >
      <Text fontSize={13} color={tokens.error} numberOfLines={2}>
        {message}
      </Text>
    </XStack>
  )
}

function ActionGroup({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <YStack gap={9}>
      <XStack ai="center" gap={6}>
        {icon}
        <Text
          fontSize={10}
          fontWeight="600"
          letterSpacing={0.6}
          textTransform="uppercase"
          color={tokens.textTertiary}
        >
          {title}
        </Text>
      </XStack>
      {children}
    </YStack>
  )
}

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
  return (
    <XStack
      testID="acceso-role-group"
      ai="center"
      gap={2}
      padding={3}
      borderRadius={10}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgInner}
      alignSelf="flex-start"
      opacity={disabled ? 0.5 : 1}
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
    </XStack>
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
  const interactive = !disabled && !active
  return (
    <XStack
      testID={`acceso-role-${role}`}
      ai="center"
      paddingVertical={7}
      paddingHorizontal={13}
      borderRadius={8}
      backgroundColor={active ? tokens.bgPress : "transparent"}
      borderWidth={1}
      borderColor={active ? tokens.borderHover : "transparent"}
      cursor={interactive ? "pointer" : "default"}
      hoverStyle={interactive ? { backgroundColor: tokens.bgHover } : {}}
      onPress={interactive ? () => onSelect(role) : undefined}
      {...({
        role: "button",
        tabIndex: interactive ? 0 : -1,
        "aria-pressed": active,
        "aria-disabled": disabled,
      } as Record<string, unknown>)}
    >
      <Text
        fontSize={13}
        fontWeight={active ? "600" : "500"}
        color={active ? tokens.text : tokens.textSecondary}
      >
        {label}
      </Text>
    </XStack>
  )
}

function ActionButton({
  testID,
  label,
  onPress,
  tone = "default",
  disabled = false,
}: {
  testID: string
  label: string
  onPress: () => void
  tone?: "default" | "danger" | "positive"
  disabled?: boolean
}) {
  const accent =
    tone === "danger" ? tokens.error : tone === "positive" ? tokens.success : tokens.accent
  return (
    <XStack
      testID={testID}
      alignSelf="flex-start"
      ai="center"
      paddingVertical={8}
      paddingHorizontal={14}
      borderRadius={8}
      borderWidth={1}
      borderColor={disabled ? tokens.border : `${accent}55`}
      backgroundColor={disabled ? tokens.bgInner : `${accent}1A`}
      opacity={disabled ? 0.5 : 1}
      cursor={disabled ? "default" : "pointer"}
      hoverStyle={disabled ? {} : { backgroundColor: `${accent}26` }}
      onPress={disabled ? undefined : onPress}
      {...({ role: "button", tabIndex: disabled ? -1 : 0, "aria-disabled": disabled } as Record<
        string,
        unknown
      >)}
    >
      <Text fontSize={13} fontWeight="600" color={disabled ? tokens.textMuted : accent}>
        {label}
      </Text>
    </XStack>
  )
}

function Hint({ text }: { text: string }) {
  return (
    <Text fontSize={11} color={tokens.textMuted}>
      {text}
    </Text>
  )
}
