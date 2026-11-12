/**
 * ChatHeader — the OS prototype's `.chat-head`.
 *
 * Transparent on the sheet with a hairline below:
 *   [story Avatar 48]  Agent name (serif xl) · ROLE (codenote)      model › ☏ ⋮
 *                      conversation title (sm text2, click to rename)
 *
 * Every action of the old header survives: rename, token usage, move to
 * workspace, scope toggle and archive live in the kebab (⋮) sheet; the
 * voice call is the phone IconBtn; the model string is a quiet link to the
 * agent window.
 */

import { useTranslation } from "react-i18next"
import { FeatureFlag } from "../FeatureFlag"
import type { TokenBudget, VoiceMode, VoicePresence } from "@teros/shared"
import type React from "react"
import { useState } from "react"
import { Modal, Platform, Pressable, StyleSheet, TextInput, View } from "react-native"
import { Sheet } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { FONT_SANS } from "../mca/primitives/fonts"
import { useTilingStore } from "../../store/tilingStore"
import { useAuthStore } from "../../store/authStore"
import { Avatar } from "../Avatar"
import { TerosLoading } from "../TerosLoading"
import { TokenBudgetDetails } from "../TokenBudgetDetails"
import { IconBtn, Ph, T } from "../ui/ds"
import { useChatPane } from "./bubbles/shared"

interface ChatHeaderProps {
  /** Conversation title/purpose */
  title: string
  /** Agent name */
  agentName: string
  /** Agent avatar URL */
  agentAvatarUrl?: string | null
  /** Agent role (e.g., 'Personal Assistant') */
  agentRole?: string
  /** Model string (e.g., 'anthropic/claude-opus-4.5') */
  modelString?: string
  /** Model display name (e.g., 'Claude Sonnet 4.5 (OpenRouter)') */
  modelName?: string
  /** Provider display name (e.g., 'OpenRouter', 'Claude Max') */
  providerName?: string
  /** Agent ID (needed to change model and start voice) */
  agentId?: string
  /** Whether the agent is working (streaming, tool calls, etc.) */
  isWorking?: boolean
  /** Whether the title was locked by the user (not editable) */
  isTitleLocked?: boolean
  /** Channel scope — 'personal' or 'shared'. */
  scope?: "personal" | "shared"
  /** Token budget data (admin only — fetched via admin-api.channel-token-budget;
   * null/undefined for non-admins, so the menu item never renders for them). */
  tokenBudget?: TokenBudget | null
  /** Workspace info (if chat belongs to a workspace) */
  workspace?: {
    name: string
    icon?: string
    color?: string
  } | null
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void
  /** Callback when archiving */
  onArchive?: () => void
  /** Callback when moving to another workspace */
  onMoveToWorkspace?: () => void
  /** Callback when user clicks the Mic button to start a voice session */
  onStartVoice?: () => void
  /** Whether there is currently an active voice session for this agent */
  isVoiceActive?: boolean
  /**
   * v2 (ui-evolution §2.7): the global presence axis — the header shows
   * presence even when the user is in another conversation (always-on is
   * visible across the app, not just in one corner). When provided, the
   * Phone button becomes a presence indicator instead of a "call active"
   * toggle.
   */
  voicePresence?: VoicePresence
  /** v2: the session mode — colors the presence dot (indigo/gris/índigo intenso). */
  voiceMode?: VoiceMode
  /** Channel scope — 'personal' or 'shared'. Undefined = not applicable. */
  channelScope?: "personal" | "shared"
  /** Whether the current user is the channel owner (can toggle scope). */
  isChannelOwner?: boolean
  /** Callback to toggle scope (personal ↔ shared). Owner only. */
  onToggleScope?: () => void
  /** Whether a pre-publish scan is in progress (shows spinner on the menu item). */
  isScanningScope?: boolean
  /**
   * WS2: agent-hours used by THIS conversation in the current billing period,
   * pre-formatted ("2.3h"). Fetched by the consumer via
   * useChannelAgentHours — the header only renders. Null/undefined hides the
   * chip (loading, no channel, or the feature is off).
   */
  agentHours?: string | null
}

export function ChatHeader({
  title,
  agentName,
  agentAvatarUrl,
  agentRole,
  modelString,
  modelName,
  providerName,
  agentId,
  isWorking = false,
  isTitleLocked = false,
  scope = "shared",
  tokenBudget,
  workspace,
  onTitleChange,
  onArchive,
  onMoveToWorkspace,
  onStartVoice,
  isVoiceActive = false,
  voicePresence,
  voiceMode,
  channelScope,
  isChannelOwner = false,
  onToggleScope,
  isScanningScope = false,
  agentHours,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const c = useColors()
  const pane = useChatPane()
  const openWindow = useTilingStore((s) => s.openWindow)
  // Token usage is admin-only (Pablo, 2026-10-30). The backend serves it
  // exclusively via admin-api.channel-token-budget (requireAdmin), so
  // tokenBudget only arrives for admins — but the render gate is explicit
  // too (defense in depth: the option can't appear for a non-admin even if
  // the prop were ever populated).
  const userRole = useAuthStore((s) => s.user?.role)
  const isAdminUser = userRole === "admin" || userRole === "super"
  const [isEditing, setIsEditing] = useState(false)
  const [editedTitle, setEditedTitle] = useState(title)
  const [showMenu, setShowMenu] = useState(false)
  const [showTokens, setShowTokens] = useState(false)
  const [titleHover, setTitleHover] = useState(false)
  const [modelHover, setModelHover] = useState(false)

  const handleStartEdit = () => {
    if (isTitleLocked) return
    setEditedTitle(title)
    setIsEditing(true)
  }

  const handleSaveEdit = () => {
    if (editedTitle.trim() && editedTitle !== title) {
      onTitleChange?.(editedTitle.trim())
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setEditedTitle(title)
    setIsEditing(false)
  }

  const handleArchive = () => {
    setShowMenu(false)
    onArchive?.()
  }

  const handleMoveToWorkspace = () => {
    setShowMenu(false)
    onMoveToWorkspace?.()
  }

  const handleRename = () => {
    setShowMenu(false)
    handleStartEdit()
  }

  const handleShowTokens = () => {
    setShowMenu(false)
    setShowTokens(true)
  }

  const handleToggleScope = () => {
    setShowMenu(false)
    onToggleScope?.()
  }

  // The model string is a quiet link to the agent window (where the model is
  // changed) — only when we know the agent. Preview routing (preview-tabs.md):
  // a plain click reuses the desktop's preview tab; only ctrl/cmd-click opens
  // a separate tab.
  const handleOpenModel = agentId
    ? () =>
        openWindow(
          "agent",
          { agentId: agentId.startsWith("agent_") ? agentId : `agent_${agentId}` },
          false,
        )
    : undefined

  const modelLabel = [providerName, modelName || modelString].filter(Boolean).join(" · ")

  // Phone glyph tone — presence (v2) wins over the legacy "call active" flag.
  const phoneOn = voicePresence
    ? voicePresence === "on" || voicePresence === "connecting"
    : isVoiceActive
  const phoneColor = voicePresence === "error" ? c.tint.r.tx : phoneOn ? c.accent : c.text2

  // Narrow panes (phones) collapse the header to one light 44px row:
  // avatar 28 · name · title, nothing stacked.
  const avatarSize = pane.narrow ? 28 : pane.compact ? 36 : 48
  const nameStep = pane.compact ? "hsm" : "xl"

  return (
    <>
      <View
        style={[
          styles.head,
          {
            gap: pane.narrow ? 8 : pane.compact ? 10 : 14,
            paddingVertical: pane.narrow ? 6 : pane.compact ? 8 : 14,
            paddingLeft: pane.narrow ? 12 : pane.compact ? 14 : 28,
            paddingRight: pane.narrow ? 12 : pane.compact ? 14 : 22,
            borderBottomColor: c.border,
          },
        ]}
      >
        {/* Agent Avatar — the story ring */}
        <Avatar
          name={agentName}
          imageUrl={agentAvatarUrl || undefined}
          size={avatarSize}
          isAgent
          status={isWorking ? "busy" : "live"}
        />

        {/* Who + conversation title */}
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: pane.narrow ? "row" : "column",
            alignItems: pane.narrow ? "baseline" : undefined,
            gap: pane.narrow ? 8 : 0,
          }}
        >
          {/* `.chat-who`: name (serif xl) · role (codenote) · working */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              gap: 10,
              minWidth: 0,
              flexShrink: 0,
              maxWidth: pane.narrow ? "50%" : undefined,
            }}
          >
            <T
              step={nameStep}
              numberOfLines={1}
              style={{ flexShrink: 1, maxWidth: pane.narrow ? undefined : "70%" }}
            >
              {agentName}
            </T>
            {agentRole && !pane.narrow ? (
              <T step="codenote" tone="text3" ellipsis style={{ flexShrink: 1, minWidth: 0 }}>
                {agentRole}
              </T>
            ) : null}
            {/* MUW-REQ-26: every viewer sees that this conversation is shared with
                the workspace — non-creators have no toggle, so this is their only cue. */}
            {channelScope === "shared" ? (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}
                testID="chat-scope-shared"
              >
                <Ph name="eye" size={11} color={c.text3} />
                <T step="codenote" tone="text3">
                  {t("conversations.sharedConversation")}
                </T>
              </View>
            ) : null}
            {/* WS2: agent-hours of this conversation in the billing period.
                Quiet text3 chip — informational, never loud. Hidden while the
                consumer hasn't provided a formatted value. */}
            {agentHours && !pane.narrow ? (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}
                testID="chat-agent-hours"
              >
                <Ph name="clock" size={11} color={c.text3} />
                <T step="codenote" tone="text3">
                  {agentHours}
                </T>
              </View>
            ) : null}
            {isWorking && (
              <View style={{ alignSelf: "center" }}>
                <TerosLoading size={14} color={c.accent} />
              </View>
            )}
          </View>

          {/* `.conv-title` — sm text2, click to rename */}
          {isEditing ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
              <TextInput
                style={[
                  styles.titleInput,
                  { backgroundColor: c.field, borderColor: c.borderAccent, color: c.text },
                  Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
                ]}
                value={editedTitle}
                onChangeText={setEditedTitle}
                autoFocus
                selectTextOnFocus
                onSubmitEditing={handleSaveEdit}
                onBlur={handleSaveEdit}
              />
              <IconBtn
                icon="check"
                plain
                sm
                on
                onPress={handleSaveEdit}
                title={t("common.save", { defaultValue: "Save" })}
              />
              <IconBtn icon="x" plain sm onPress={handleCancelEdit} title={t("common.cancel")} />
            </View>
          ) : (
            <Pressable
              onPress={handleStartEdit}
              disabled={isTitleLocked}
              {...(Platform.OS === "web"
                ? ({
                    onHoverIn: () => setTitleHover(true),
                    onHoverOut: () => setTitleHover(false),
                  } as any)
                : {})}
              style={[
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  marginTop: pane.narrow ? 0 : 2,
                  alignSelf: "flex-start",
                  maxWidth: "100%",
                  flexShrink: 1,
                  minWidth: 0,
                },
                Platform.OS === "web"
                  ? ({ cursor: isTitleLocked ? "default" : "text" } as any)
                  : null,
              ]}
            >
              {scope === "personal" && <Ph name="lock" size={11} color={c.accent} />}
              {scope === "shared" && <Ph name="users-three" size={11} color={c.text3} />}
              <T
                step={pane.narrow ? "12" : "sm"}
                color={titleHover && !isTitleLocked ? c.text : pane.narrow ? c.text3 : c.text2}
                ellipsis
                style={{ flexShrink: 1 }}
              >
                {title}
              </T>
            </Pressable>
          )}
        </View>

        {/* Right: model › · phone · kebab */}
        {!pane.compact && modelLabel ? (
          <Pressable
            onPress={handleOpenModel}
            disabled={!handleOpenModel}
            {...(Platform.OS === "web"
              ? ({
                  onHoverIn: () => setModelHover(true),
                  onHoverOut: () => setModelHover(false),
                  title: modelString,
                } as any)
              : {})}
            style={[
              { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 260, marginRight: 4 },
              Platform.OS === "web"
                ? ({ cursor: handleOpenModel ? "pointer" : "default" } as any)
                : null,
            ]}
          >
            <T
              step="sm"
              color={modelHover && handleOpenModel ? c.accent : c.text3}
              ellipsis
              style={{ flexShrink: 1 }}
            >
              {modelLabel}
            </T>
            <Ph
              name="caret-right"
              size={12}
              color={modelHover && handleOpenModel ? c.accent : c.text3}
            />
          </Pressable>
        ) : null}

        {/* Phone button — v2: presence indicator (ui-evolution §2.7).
            With voicePresence provided, the button shows the GLOBAL
            presence axis (accent = on, visible even from another
            conversation). Without it, the legacy "call active" toggle. */}
        {onStartVoice && (
          <FeatureFlag flag="voice.enabled">
            <IconBtn
              icon="phone"
              plain
              on={phoneOn}
              color={phoneColor}
              weight={phoneOn ? "fill" : "regular"}
              onPress={onStartVoice}
              title={
                isVoiceActive ? "Voice active — press Esc to stop" : "Start voice — or press Ctrl+M"
              }
              testID="chat-voice-button"
            />
          </FeatureFlag>
        )}

        {/* Menu ⋮ */}
        <IconBtn
          icon="dots-three-vertical"
          plain
          weight="bold"
          onPress={() => setShowMenu(true)}
          title={t("common.more", { defaultValue: "More" })}
          testID="chat-menu-button"
        />
      </View>

      {/* Menu Sheet */}
      <Sheet
        modal
        open={showMenu}
        onOpenChange={setShowMenu}
        snapPoints={[40]}
        dismissOnSnapToBottom
        zIndex={100000}
      >
        <Sheet.Overlay
          animation="medium"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor="rgba(32,28,39,0.45)"
        />
        <Sheet.Frame
          backgroundColor={c.bgStep}
          borderTopLeftRadius={16}
          borderTopRightRadius={16}
          padding={8}
        >
          <Sheet.Handle backgroundColor={c.borderStrong} />

          <View style={{ gap: 2, paddingTop: 8 }}>
            {!isTitleLocked && (
              <MenuItem
                icon={<Ph name="pencil-simple" size={16} color={c.text2} />}
                label={t("conversation.rename")}
                onPress={handleRename}
              />
            )}

            {isAdminUser && tokenBudget && (
              <MenuItem
                icon={<Ph name="chart-bar" size={16} color={c.text2} />}
                label={t("conversation.viewTokenUsage")}
                onPress={handleShowTokens}
              />
            )}

            {onMoveToWorkspace && (
              <MenuItem
                icon={<Ph name="arrows-left-right" size={16} color={c.accent} />}
                label={t("conversations.moveToWorkspace")}
                onPress={handleMoveToWorkspace}
              />
            )}

            {/* Scope toggle — only shown to the channel owner (MUW-15).
                Uses the same pre-publish scan → warning dialog flow as the list. */}
            {isChannelOwner && onToggleScope && channelScope && (
              <MenuItem
                icon={
                  isScanningScope ? (
                    <TerosLoading size={16} color={c.accent} />
                  ) : channelScope === "shared" ? (
                    <Ph name="eye-slash" size={16} color={c.accent} />
                  ) : (
                    <Ph name="eye" size={16} color={c.accent} />
                  )
                }
                label={
                  channelScope === "shared"
                    ? t("conversations.makePersonal")
                    : t("conversations.makeShared")
                }
                onPress={handleToggleScope}
              />
            )}

            {onArchive && (
              <MenuItem
                icon={<Ph name="archive" size={16} color={c.text2} />}
                label={t("conversation.archiveConversation")}
                onPress={handleArchive}
              />
            )}
          </View>
        </Sheet.Frame>
      </Sheet>

      {/* Token Budget Modal */}
      <Modal
        visible={showTokens}
        transparent
        animationType="fade"
        onRequestClose={() => setShowTokens(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: "rgba(32,28,39,0.45)" }]}
          onPress={() => setShowTokens(false)}
        >
          <Pressable
            style={[
              styles.modalContent,
              { backgroundColor: c.bgStep },
              Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <T step="hsm">{t("conversation.tokenUsage")}</T>
              <IconBtn icon="x" plain sm onPress={() => setShowTokens(false)} />
            </View>

            {tokenBudget && <TokenBudgetDetails budget={tokenBudget} />}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

function MenuItem({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode
  label: string
  onPress: () => void
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      {...(Platform.OS === "web"
        ? ({ onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) } as any)
        : {})}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: pressed ? c.nestHover : hover ? c.nest : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      {icon}
      <T step="sm">{label}</T>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    backgroundColor: "transparent",
    zIndex: 10,
  },
  titleInput: {
    flex: 1,
    maxWidth: 420,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 0,
    fontFamily: FONT_SANS,
    fontSize: 13,
    fontWeight: "400",
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    borderRadius: 16,
    padding: 16,
    width: "100%",
    maxWidth: 420,
    maxHeight: "80%",
  },
})
