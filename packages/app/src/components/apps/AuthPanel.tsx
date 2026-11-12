/**
 * AuthPanel Component
 *
 * Collapsible panel for app authentication configuration, in the OS
 * prototype's language (a lifted Card with a status Dot, section notes on
 * the wash, Field inputs and pill buttons). Contains two subsections:
 * 1. OAuth Connection - Connect/disconnect OAuth accounts
 * 2. Credentials - Edit API keys and secrets
 */

import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Linking, Platform, Pressable, View } from "react-native"
import { usePulseAnimation } from "../../hooks/usePulseAnimation"
import { AppSpinner } from "../../components/ui"
import { ConfirmDialog } from "../../components/mca/primitives/ConfirmDialog"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  type BadgeTone,
  Btn,
  Card,
  Field,
  FieldHelp,
  FieldLabel,
  IconBtn,
  Ph,
  T,
} from "../ui/ds"

// ============================================================================
// Types
// ============================================================================

export type OAuthStatus = "connected" | "disconnected" | "expired" | "error"

export interface OAuthInfo {
  provider: string
  status: OAuthStatus
  email?: string
  /**
   * Login/handle del proveedor (e.g. GitHub `login`). Cuando esté presente
   * se prefiere mostrar `@${userLogin}` sobre el email — relevante para
   * GitHub App con userOAuth donde el email puede no estar verificado.
   */
  userLogin?: string
  expiresAt?: string
  scopes?: string[]
  error?: string
  /**
   * Auth method used by the MCA. `github-app` swaps the OAuth-style
   * "Connect" copy for GitHub App-style "Install" copy and adds a banner
   * pointing to `/settings/installations/<id>` on github.com when connected.
   * Defaults to `'oauth2'` when omitted.
   */
  authType?: "oauth2" | "github-app"
  /** GitHub App installation ID (only when `authType === 'github-app'` and connected). */
  installationId?: string
  /** GitHub App slug — used to build the install URL. */
  appSlug?: string
  /** True when a legacy OAuth ACCESS_TOKEN is present without an INSTALLATION_ID — surface migration banner. */
  legacyOAuth?: boolean
  installed?: boolean
  installUrl?: string
  installations?: GitHubInstallation[]
  savedBranches?: GitHubSavedBranch[]
}

export interface GitHubSavedBranch {
  repo: string
  branch: string
  savedAt: string
  url: string
}

export interface GitHubInstallation {
  id: string
  account: string
  accountType?: string
  manageUrl?: string
  suspended?: boolean
  pendingPermissions?: string[]
}

const TAP_SLOP = { top: 8, bottom: 8, left: 4, right: 4 }

export interface CredentialField {
  name: string
  label?: string
  type: "text" | "password"
  required: boolean
  placeholder?: string
  hint?: string
  value?: string
  isSet?: boolean
}

export interface AuthPanelProps {
  /** OAuth info (null if not OAuth-based) */
  oauth?: OAuthInfo | null
  /** Credential fields to display */
  credentials?: CredentialField[]
  /** Loading state */
  loading?: boolean
  /** Whether there are unsaved changes */
  hasChanges?: boolean
  /** Saving state */
  saving?: boolean
  /** OAuth callbacks */
  onConnect?: () => void
  onDisconnect?: () => void
  onRefresh?: () => void
  connecting?: boolean
  disconnecting?: boolean
  /** Credentials callbacks */
  onCredentialChange?: (name: string, value: string) => void
  onSaveCredentials?: () => void
  /** Initial expanded state */
  defaultExpanded?: boolean
  /** Message shown when system-level secrets are missing (admin must configure) */
  systemSetupMessage?: string
}

type PanelStatus = "ready" | "pending" | "warning" | "error"
type BadgeVariant = "green" | "blue" | "yellow" | "red" | "gray"

const VARIANT_TONE: Record<BadgeVariant, BadgeTone> = {
  green: "g",
  blue: "i",
  yellow: "a",
  red: "r",
  gray: "muted",
}

const STATUS_COLOR: Record<PanelStatus, string> = {
  ready: semantic.green,
  pending: semantic.purple300,
  warning: semantic.amber,
  error: semantic.red,
}

// ============================================================================
// Status Dot Component
// ============================================================================

function StatusDot({ status }: { status: PanelStatus }) {
  const pulseAnim = usePulseAnimation(status === "pending")
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: STATUS_COLOR[status],
        flexShrink: 0,
        opacity: status === "pending" ? pulseAnim : 1,
      }}
    />
  )
}

// ============================================================================
// Note (`.ap-note`) — a wash box with an icon and a line of copy
// ============================================================================

function Note({
  tone,
  icon,
  children,
}: {
  tone: "neutral" | "amber" | "red" | "info"
  icon: string
  children: React.ReactNode
}) {
  const c = useColors()
  const bg =
    tone === "amber"
      ? c.tint.a.bg
      : tone === "red"
        ? c.tint.r.bg
        : tone === "info"
          ? c.tint.i.bg
          : c.wash
  const fg =
    tone === "amber"
      ? c.tint.a.tx
      : tone === "red"
        ? c.tint.r.tx
        : tone === "info"
          ? c.tint.i.tx
          : c.text2
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: bg,
      }}
    >
      <Ph
        name={icon}
        size={16}
        color={tone === "neutral" ? c.text3 : fg}
        style={{ marginTop: 1 }}
      />
      <T step="12" color={fg} style={{ flex: 1, lineHeight: 17 }}>
        {children}
      </T>
    </View>
  )
}

// ============================================================================
// Credential Input Component
// ============================================================================

interface CredentialInputProps {
  field: CredentialField
  onChange: (value: string) => void
}

function CredentialInput({ field, onChange }: CredentialInputProps) {
  const c = useColors()
  const alreadySet = !!(field.isSet && !field.value)
  const [editing, setEditing] = useState(!alreadySet)
  const [showValue, setShowValue] = useState(false)
  const [localValue, setLocalValue] = useState(field.value || "")

  const isPassword = field.type === "password"
  const displayLabel = field.label || field.name
  const isConfigured = alreadySet || !!localValue

  const handleChange = (text: string) => {
    setLocalValue(text)
    onChange(text)
  }

  return (
    <View style={{ marginBottom: 16 }}>
      <FieldLabel
        required={field.required && !isConfigured}
        right={
          !field.required ? (
            <T step="codenote" tone="text3">
              opcional
            </T>
          ) : !isConfigured ? (
            <T step="codenote" tone="danger">
              requerido
            </T>
          ) : null
        }
      >
        {displayLabel}
      </FieldLabel>

      {/* Configured state — collapsed */}
      {isConfigured && !editing ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            height: 36,
            paddingLeft: 14,
            paddingRight: 6,
            backgroundColor: c.field,
            borderWidth: 1,
            borderColor: c.tint.g.bd,
            borderRadius: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ph name="check" size={13} color={c.tint.g.tx} />
            <T step="code" color={c.tint.g.tx}>
              {"•".repeat(16)}
            </T>
          </View>
          <Btn variant="ghost" size="sm" icon="pencil-simple" onPress={() => setEditing(true)}>
            Cambiar
          </Btn>
        </View>
      ) : (
        /* Edit state — full input */
        <Field
          mono
          value={localValue}
          onChangeText={handleChange}
          placeholder={field.placeholder}
          secureTextEntry={isPassword && !showValue}
          autoFocus={alreadySet}
          containerStyle={{ paddingRight: 6 }}
          right={
            <View style={{ flexDirection: "row", gap: 2 }}>
              {isPassword ? (
                <IconBtn
                  icon={showValue ? "eye-slash" : "eye"}
                  plain
                  sm
                  onPress={() => setShowValue(!showValue)}
                />
              ) : null}
              {alreadySet ? (
                <IconBtn
                  icon="x"
                  plain
                  sm
                  onPress={() => {
                    setEditing(false)
                    setLocalValue("")
                    onChange("")
                  }}
                />
              ) : null}
            </View>
          }
        />
      )}

      {field.hint ? <FieldHelp>{field.hint}</FieldHelp> : null}
    </View>
  )
}

// ============================================================================
// OAuth Section Component
// ============================================================================

interface OAuthSectionProps {
  oauth: OAuthInfo
  onConnect?: () => void
  onDisconnect?: () => void
  onRefresh?: () => void
  connecting?: boolean
  disconnecting?: boolean
}

function OAuthSection({
  oauth,
  onConnect,
  onRefresh,
  connecting,
}: OAuthSectionProps) {
  const c = useColors()
  const { t } = useTranslation()
  const isConnected = oauth.status === "connected"
  const isExpired = oauth.status === "expired"
  const isError = oauth.status === "error"
  const needsConnect = oauth.status === "disconnected"
  const isGitHubApp = oauth.authType === "github-app"
  const isLegacyOAuth = oauth.legacyOAuth === true
  const provider = oauth.provider

  const badge: { text: string; variant: BadgeVariant } = {
    connected: { text: t("authPanel.status.connected"), variant: "green" as BadgeVariant },
    disconnected: { text: t("authPanel.status.disconnected"), variant: "blue" as BadgeVariant },
    expired: { text: t("authPanel.status.expired"), variant: "yellow" as BadgeVariant },
    error: { text: t("authPanel.status.error"), variant: "red" as BadgeVariant },
  }[oauth.status]

  const sectionTitle = isGitHubApp ? "GitHub" : t("authPanel.oauthTitle")

  const primary = oauth.userLogin ? `@${oauth.userLogin}` : (oauth.email ?? "")
  const secondary = oauth.userLogin && oauth.email ? oauth.email : null
  const showAccount = (isConnected || isExpired) && !!primary
  const installations = oauth.installations
  const installUrl =
    oauth.installUrl ??
    (oauth.appSlug ? `https://github.com/apps/${oauth.appSlug}/installations/select_target` : undefined)

  return (
    <View style={{ padding: 16, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T step="xs" tone="text3">
          {sectionTitle}
        </T>
        <Badge tone={VARIANT_TONE[badge.variant]} mono sm>
          {badge.text}
        </Badge>
      </View>

      {isGitHubApp && isLegacyOAuth ? (
        <Note tone="amber" icon="warning-circle">
          {t("authPanel.github.legacy")}
        </Note>
      ) : null}

      {needsConnect || isExpired || isError ? (
        <Note
          tone={isError ? "red" : isExpired ? "amber" : "info"}
          icon={isError ? "warning-circle" : "info"}
        >
          {isError
            ? oauth.error || t("authPanel.errorValidating")
            : isExpired
              ? t("authPanel.expiredNote")
              : isGitHubApp
                ? t("authPanel.github.connectNote")
                : t("authPanel.connectNote", { provider })}
        </Note>
      ) : null}

      {showAccount ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            padding: 10,
            paddingHorizontal: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bgStep,
            opacity: isExpired ? 0.7 : 1,
          }}
        >
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: isExpired ? c.tint.a.bg : c.tint.m.bg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <T step="bserif" color={isExpired ? c.tint.a.tx : c.tint.m.tx}>
              {(oauth.userLogin?.charAt(0) ?? oauth.email?.charAt(0) ?? "?").toUpperCase()}
            </T>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T step="sm" ellipsis>
              {primary}
            </T>
            <T step="12" color={isExpired ? c.tint.a.tx : c.text3} ellipsis>
              {isExpired ? t("authPanel.expiredAccount") : (secondary ?? provider ?? t("authPanel.status.connected"))}
            </T>
          </View>
        </View>
      ) : null}

      {isConnected && isGitHubApp && oauth.installed === false ? (
        <Note tone="amber" icon="warning-circle">
          {t("authPanel.github.notInstalled")}
        </Note>
      ) : null}

      {isConnected && isGitHubApp && installations && installations.length > 0 ? (
        <View style={{ gap: 8 }}>
          <T step="12" tone="text3">
            {t("authPanel.github.installationsTitle")}
          </T>
          {installations.map((inst) => (
            <View
              key={inst.id}
              style={{ gap: 8, padding: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <T step="sm" style={{ flex: 1, minWidth: 120 }} ellipsis>
                  {`@${inst.account}`}
                </T>
                {inst.accountType === "Organization" ? (
                  <Badge tone="m" sm>
                    {t("authPanel.github.organization")}
                  </Badge>
                ) : null}
                {inst.suspended ? (
                  <Badge tone="r" sm>
                    {t("authPanel.github.suspended")}
                  </Badge>
                ) : null}
                {inst.manageUrl ? (
                  <Btn
                    variant="sec"
                    size="sm"
                    iconRight="arrow-up-right"
                    hitSlop={TAP_SLOP}
                    accessibilityLabel={t("authPanel.github.manageA11y", { account: inst.account })}
                    onPress={() => Linking.openURL(inst.manageUrl as string)}
                  >
                    {t("authPanel.github.manage")}
                  </Btn>
                ) : null}
              </View>
              {inst.pendingPermissions && inst.pendingPermissions.length > 0 ? (
                <View style={{ gap: 8 }}>
                  <Note tone="amber" icon="warning-circle">
                    {t("authPanel.github.pendingPermissions", {
                      account: inst.account,
                      permissions: inst.pendingPermissions.map((p) => t(`authPanel.github.permission.${p}`, { defaultValue: p })).join(", "),
                    })}
                  </Note>
                  {inst.manageUrl ? (
                    <Btn
                      variant="amber"
                      size="sm"
                      iconRight="arrow-up-right"
                      hitSlop={TAP_SLOP}
                      accessibilityLabel={t("authPanel.github.reviewA11y", { account: inst.account })}
                      onPress={() => Linking.openURL(inst.manageUrl as string)}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {t("authPanel.github.review")}
                    </Btn>
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {isConnected && isGitHubApp && installUrl ? (
        <View style={{ gap: 10, padding: 12, paddingHorizontal: 14, borderRadius: 10, backgroundColor: c.wash }}>
          <T step="12" tone="text2" style={{ lineHeight: 17 }}>
            {t("authPanel.github.installHint")}
          </T>
          <Btn
            variant={oauth.installed === false ? "primary" : "sec"}
            size="sm"
            icon="folder-plus"
            iconRight="arrow-up-right"
            hitSlop={TAP_SLOP}
            accessibilityLabel={t("authPanel.github.installA11y")}
            onPress={() => Linking.openURL(installUrl)}
            style={{ alignSelf: "flex-start" }}
          >
            {oauth.installed === false ? t("authPanel.github.install") : t("authPanel.github.addAccount")}
          </Btn>
          <T step="12" tone="text3" style={{ lineHeight: 17 }}>
            {t("authPanel.github.cloneVisibility")}
          </T>
        </View>
      ) : null}

      {isConnected && isGitHubApp && oauth.savedBranches && oauth.savedBranches.length > 0 ? (
        <View style={{ gap: 8 }}>
          <T step="12" tone="text3">
            {t("authPanel.github.savedTitle")}
          </T>
          {oauth.savedBranches.map((saved) => (
            <View
              key={`${saved.repo}:${saved.branch}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", padding: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}
            >
              <View style={{ flex: 1, minWidth: 160 }}>
                <T step="code" ellipsis>
                  {saved.branch}
                </T>
                <T step="12" tone="text3" ellipsis>
                  {t("authPanel.github.savedMeta", { repo: saved.repo, date: saved.savedAt.slice(0, 16).replace("T", " ") })}
                </T>
              </View>
              <Btn
                variant="sec"
                size="sm"
                iconRight="arrow-up-right"
                hitSlop={TAP_SLOP}
                accessibilityLabel={t("authPanel.github.savedOpenA11y", { branch: saved.branch })}
                onPress={() => Linking.openURL(saved.url)}
              >
                {t("authPanel.github.savedOpen")}
              </Btn>
            </View>
          ))}
        </View>
      ) : null}

      {isConnected && onRefresh ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Btn variant="sec" icon="arrows-clockwise" hitSlop={TAP_SLOP} onPress={onRefresh}>
            {t("authPanel.refresh")}
          </Btn>
        </View>
      ) : null}

      {(needsConnect || isExpired || isError) && onConnect ? (
        <Btn
          variant={isExpired ? "amber" : "primary"}
          icon="plugs-connected"
          loading={connecting}
          hitSlop={TAP_SLOP}
          onPress={onConnect}
          style={{ alignSelf: "flex-start" }}
        >
          {isExpired
            ? t("authPanel.reconnect", { provider })
            : t("authPanel.connect", { provider })}
        </Btn>
      ) : null}
    </View>
  )
}

export interface DisconnectButtonProps {
  provider: string
  label: string
  busy?: boolean
  onConfirm: () => void
}

export function DisconnectButton({ provider, label, busy, onConfirm }: DisconnectButtonProps) {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  return (
    <>
      <Btn variant="dangerSoft" icon="plugs" loading={busy} hitSlop={TAP_SLOP} onPress={() => setAsking(true)}>
        {label}
      </Btn>
      <ConfirmDialog
        visible={asking}
        variant="deny"
        title={t("authPanel.disconnectConfirm.title", { provider })}
        message={t("authPanel.disconnectConfirm.message", { provider })}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          onConfirm()
        }}
      />
    </>
  )
}

// ============================================================================
// Credentials Section Component
// ============================================================================

interface CredentialsSectionProps {
  credentials: CredentialField[]
  onCredentialChange: (name: string, value: string) => void
}

function CredentialsSection({ credentials, onCredentialChange }: CredentialsSectionProps) {
  const { t } = useTranslation()
  if (credentials.length === 0) return null

  return (
    <View style={{ padding: 16 }}>
      {/* Subsection header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <T step="xs" tone="text3">
          {t("authPanel.credentials")}
        </T>
      </View>

      {/* Credential inputs */}
      {credentials.map((field) => (
        <CredentialInput
          key={field.name}
          field={field}
          onChange={(value) => onCredentialChange(field.name, value)}
        />
      ))}
    </View>
  )
}

// ============================================================================
// Save Bar Component
// ============================================================================

interface SaveBarProps {
  onSave: () => void
  saving?: boolean
}

function SaveBar({ onSave, saving }: SaveBarProps) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: 12,
        paddingHorizontal: 16,
        backgroundColor: c.tint.i.bg,
        borderTopWidth: 1,
        borderTopColor: c.tint.i.bd,
      }}
    >
      <T step="12" color={c.tint.i.tx}>
        Tienes cambios sin guardar
      </T>
      <Btn variant="primary" size="sm" icon="check" loading={saving} onPress={onSave}>
        Guardar
      </Btn>
    </View>
  )
}

// ============================================================================
// Main AuthPanel Component
// ============================================================================

export function AuthPanel({
  oauth,
  credentials = [],
  loading = false,
  hasChanges = false,
  saving = false,
  onConnect,
  onDisconnect,
  onRefresh,
  connecting = false,
  disconnecting = false,
  onCredentialChange,
  onSaveCredentials,
  defaultExpanded = true,
  systemSetupMessage,
}: AuthPanelProps) {
  const c = useColors()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)

  // Determine overall status
  const getStatus = (): PanelStatus => {
    if (systemSetupMessage) return "warning"
    if (oauth) {
      if (oauth.status === "connected") return "ready"
      if (oauth.status === "disconnected") return "pending"
      if (oauth.status === "expired") return "warning"
      if (oauth.status === "error") return "error"
    }
    const requiredMissing = credentials.some((c) => c.required && !c.isSet && !c.value)
    if (requiredMissing) return "pending"
    return "ready"
  }

  // Determine badge text
  const getBadge = (): { text: string; variant: BadgeVariant } => {
    if (systemSetupMessage) return { text: t("authPanel.badge.adminRequired"), variant: "yellow" }

    const oauthPart = oauth ? (oauth.status === "connected" ? "OAuth" : "") : ""
    const credCount = credentials.filter((c) => c.isSet || c.value).length
    const credPart = credCount > 0 ? `${credCount} key${credCount > 1 ? "s" : ""}` : ""

    if (oauthPart && credPart) return { text: `${oauthPart} + ${credPart}`, variant: "green" }
    if (oauthPart) return { text: oauthPart, variant: "green" }
    if (credPart) return { text: credPart, variant: "green" }

    if (oauth?.status === "disconnected") return { text: t("authPanel.badge.connect"), variant: "blue" }
    if (oauth?.status === "expired") return { text: t("authPanel.status.expired"), variant: "yellow" }
    if (oauth?.status === "error") return { text: "error", variant: "red" }

    const requiredMissing = credentials.some((c) => c.required && !c.isSet && !c.value)
    if (requiredMissing) return { text: t("authPanel.badge.configure"), variant: "blue" }

    return { text: "N/A", variant: "gray" }
  }

  const status = getStatus()
  const badge = getBadge()

  return (
    <Card>
      {/* Header */}
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(!expanded)}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 14,
            paddingHorizontal: 16,
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <StatusDot status={status} />
        <Ph name="key" size={16} color={c.accent} />
        <T step="sm" style={{ flex: 1 }}>
          {t("authPanel.title")}
        </T>
        {loading ? (
          <AppSpinner size="sm" variant="muted" />
        ) : (
          <Badge tone={VARIANT_TONE[badge.variant]} mono sm>
            {badge.text}
          </Badge>
        )}
        <Ph name={expanded ? "caret-up" : "caret-down"} size={14} color={c.text3} />
      </Pressable>

      {/* Content */}
      {expanded ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
          {/* System setup warning */}
          {systemSetupMessage ? (
            <View style={{ padding: 12 }}>
              <Note tone="amber" icon="warning-circle">
                {systemSetupMessage}
              </Note>
            </View>
          ) : null}

          {/* OAuth section */}
          {oauth ? (
            <OAuthSection
              oauth={oauth}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRefresh={onRefresh}
              connecting={connecting}
              disconnecting={disconnecting}
            />
          ) : null}

          {/* Credentials section */}
          {credentials.length > 0 && onCredentialChange ? (
            <CredentialsSection credentials={credentials} onCredentialChange={onCredentialChange} />
          ) : null}

          {/* Save bar */}
          {hasChanges && onSaveCredentials ? (
            <SaveBar onSave={onSaveCredentials} saving={saving} />
          ) : null}
        </View>
      ) : null}
    </Card>
  )
}

export default AuthPanel
