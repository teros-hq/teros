import { useTranslation } from "react-i18next"
import { Image } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { useColors } from "../../mca/primitives/useColors"
import { useTilingStore } from "../../../store/tilingStore"
import { ChipBtn, Ph, T } from "../../ui/ds"

/**
 * EventBubble — renders all event types emitted by EventHandler:
 *   reminder, recurring_task, system_resume, task_update (legacy)
 *   channel_started, channel_finished, channel_permission, channel_resolved
 */

/**
 * System Event bubble (reminders, recurring tasks, system_resume)
 * Compact, full-width, subtle design
 */
export function EventBubble({
  eventType,
  eventData,
  description,
  timestamp,
  showTimestamp = true,
}: {
  eventType: string
  eventData: Record<string, any>
  description?: string
  timestamp: Date
  showTimestamp?: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  const getIconAndLabel = () => {
    switch (eventType) {
      case "channel_started":
        return {
          icon: <Ph name="clock" size={13} color={c.text3} />,
          label: t("conversation.events.started"),
        }
      case "channel_finished":
        return {
          icon: <Ph name="check-circle" size={13} color={c.tint.g.tx} />,
          label: t("conversation.events.finished"),
        }
      case "task_update":
        return eventData.running
          ? {
              icon: <Ph name="clock" size={13} color={c.text3} />,
              label: t("conversation.events.taskUpdated"),
            }
          : {
              icon: <Ph name="pause" size={13} color={c.text3} />,
              label: t("conversation.events.taskUpdated"),
            }
      case "reminder":
        return {
          icon: <Ph name="bell" size={13} color={c.tint.a.tx} />,
          label: t("conversation.events.reminder"),
        }
      case "recurring_task":
        return {
          icon: <Ph name="arrows-clockwise" size={13} color={c.text3} />,
          label: t("conversation.events.recurringTask"),
        }
      case "system_resume":
        return {
          icon: <Ph name="arrows-clockwise" size={13} color={c.text3} />,
          label: t("conversation.events.systemResume"),
        }
      default:
        return {
          icon: <Ph name="clock" size={13} color={c.text3} />,
          label: t("conversation.events.event"),
        }
    }
  }

  const { icon, label } = getIconAndLabel()

  // ------------------------------------------------------------------
  // channel_permission — observed channel needs approval
  // ------------------------------------------------------------------
  if (eventType === "channel_permission") {
    const { observedChannelId, observedChannelName, toolName } = eventData
    const shortTool = toolName ? String(toolName).split("_").pop() : "tool"
    return (
      <XStack
        width="100%"
        paddingVertical={8}
        paddingHorizontal={12}
        backgroundColor={c.tint.a.bg}
        borderRadius={12}
        borderWidth={1}
        borderColor={c.tint.a.bd}
        alignItems="center"
        gap={8}
      >
        <Ph name="lock" size={13} color={c.tint.a.tx} />
        <YStack flex={1} gap={1}>
          <T step="12" color={c.tint.a.tx}>
            {t("conversation.events.needsApproval", {
              channel: observedChannelName || t("conversation.events.observedChannel"),
            })}
          </T>
          <T step="codenote" tone="text3">
            {t("conversation.events.tool", { tool: shortTool })}
          </T>
        </YStack>
        {observedChannelId && (
          <ChipBtn
            icon="arrow-square-out"
            onPress={() => openWindow("chat", { channelId: observedChannelId }, false)}
          >
            {t("conversation.events.goToApprove")}
          </ChipBtn>
        )}
      </XStack>
    )
  }

  // ------------------------------------------------------------------
  // channel_finished — sub-channel finished its turn (TER-352 / TER-461)
  // Acepta los dos shapes de emisor: ruta interna (observedChannel*, vía
  // message-handler.emitTurnEvent / complete-my-task) y ruta MCA
  // event-subscription (channel*, payload crudo del topic channel:turn_end).
  // ------------------------------------------------------------------
  if (eventType === "channel_finished") {
    const channelId = eventData.observedChannelId ?? eventData.channelId
    const channelName = eventData.observedChannelName ?? eventData.channelName
    return (
      <XStack
        width="100%"
        paddingVertical={8}
        paddingHorizontal={12}
        backgroundColor={c.tint.g.bg}
        borderRadius={12}
        borderWidth={1}
        borderColor={c.tint.g.bd}
        alignItems="center"
        gap={8}
      >
        <Ph name="check-circle" size={13} color={c.tint.g.tx} />
        <T step="12" color={c.tint.g.tx} style={{ flex: 1 }}>
          {t("conversation.events.channelFinished", { channel: channelName || channelId })}
        </T>
        {channelId && (
          <ChipBtn icon="arrow-square-out" onPress={() => openWindow("chat", { channelId }, false)}>
            {t("conversation.events.open")}
          </ChipBtn>
        )}
      </XStack>
    )
  }

  // ------------------------------------------------------------------
  // channel_resolved — permission approved or denied
  // ------------------------------------------------------------------
  if (eventType === "channel_resolved") {
    const { observedChannelName, toolName, resolution } = eventData
    const shortTool = toolName ? String(toolName).split("_").pop() : "tool"
    const isGranted = resolution === "granted"
    return (
      <XStack
        width="100%"
        paddingVertical={8}
        paddingHorizontal={12}
        backgroundColor={isGranted ? c.tint.g.bg : c.tint.r.bg}
        borderRadius={12}
        borderWidth={1}
        borderColor={isGranted ? c.tint.g.bd : c.tint.r.bd}
        alignItems="center"
        gap={8}
      >
        {isGranted ? (
          <Ph name="check-circle" size={13} color={c.tint.g.tx} />
        ) : (
          <Ph name="x-circle" size={13} color={c.tint.r.tx} />
        )}
        <T step="12" color={isGranted ? c.tint.g.tx : c.tint.r.tx} style={{ flex: 1 }}>
          {isGranted
            ? t("conversation.events.approved", { channel: observedChannelName, tool: shortTool })
            : t("conversation.events.denied", { channel: observedChannelName, tool: shortTool })}
        </T>
      </XStack>
    )
  }

  // ------------------------------------------------------------------
  // permission_timeout — HISTORICAL only. The auto-deny countdown was
  // removed (requests now wait indefinitely); this renderer stays so
  // old persisted events in channel history still display correctly.
  // ------------------------------------------------------------------
  if (eventType === "permission_timeout") {
    const { toolName } = eventData
    const shortTool = toolName ? String(toolName).split("_").pop() : "tool"
    return (
      <XStack
        width="100%"
        paddingVertical={8}
        paddingHorizontal={12}
        backgroundColor={c.wash}
        borderRadius={12}
        alignItems="center"
        gap={8}
      >
        <Ph name="clock" size={13} color={c.text3} />
        <YStack flex={1} gap={1}>
          <T step="12" tone="text2">
            {t("conversation.events.permissionTimedOut")}
          </T>
          <T step="codenote" tone="text3">
            {t("conversation.events.autodenied", { tool: shortTool })}
          </T>
        </YStack>
      </XStack>
    )
  }

  // ------------------------------------------------------------------
  // channel_started — sub-channel started working
  // ------------------------------------------------------------------
  if (eventType === "channel_started") {
    // Acepta los dos shapes de emisor: ruta interna (observedChannel*) y
    // ruta MCA event-subscription (channel*). Ver channel_finished.
    const channelId = eventData.observedChannelId ?? eventData.channelId
    const channelName = eventData.observedChannelName ?? eventData.channelName
    return (
      <XStack
        width="100%"
        paddingVertical={8}
        paddingHorizontal={12}
        backgroundColor={c.tint.i.bg}
        borderRadius={12}
        borderWidth={1}
        borderColor={c.tint.i.bd}
        alignItems="center"
        gap={8}
      >
        <Ph name="clock" size={13} color={c.tint.i.tx} />
        <T step="12" color={c.tint.i.tx} style={{ flex: 1 }}>
          {t("conversation.events.channelStarted", { channel: channelName || channelId })}
        </T>
        {channelId && (
          <ChipBtn icon="arrow-square-out" onPress={() => openWindow("chat", { channelId }, false)}>
            {t("conversation.events.open")}
          </ChipBtn>
        )}
      </XStack>
    )
  }

  // Parse message to extract agent name and create badge
  const renderMessage = () => {
    const message = eventData.message || description || t("conversation.events.systemEvent")
    const agentName = eventData.agentName
    const agentAvatar = eventData.agentAvatar

    // If we have agent info, render message with agent badge
    if (agentName && agentAvatar) {
      // Split message to insert agent badge
      // Common patterns: "Nira started...", "Task assigned to Nira", "Nira created..."
      const messageWithoutEmoji = message.replace(/^[🔄⏸️📋⏰🔄]+\s*/, "")

      // Try to find agent name in message and replace with badge
      const agentNameIndex = messageWithoutEmoji.indexOf(agentName)

      if (agentNameIndex !== -1) {
        const before = messageWithoutEmoji.substring(0, agentNameIndex)
        const after = messageWithoutEmoji.substring(agentNameIndex + agentName.length)

        return (
          <XStack gap="$1.5" alignItems="center" flexWrap="wrap" flex={1}>
            {before.length > 0 && (
              <Text color={c.text3} fontSize="$2">
                {before}
              </Text>
            )}
            <XStack
              gap={6}
              alignItems="center"
              paddingVertical={2}
              paddingHorizontal={8}
              paddingLeft={2}
              backgroundColor={c.wash}
              borderRadius={100}
            >
              <Image source={{ uri: agentAvatar }} width={16} height={16} borderRadius={8} />
              <T step="12" tone="text2">
                {agentName}
              </T>
            </XStack>
            {after.length > 0 && (
              <Text color={c.text3} fontSize="$2">
                {after}
              </Text>
            )}
          </XStack>
        )
      }
    }

    // Fallback: render plain message without emoji
    const messageWithoutEmoji = message.replace(/^[🔄⏸️📋⏰🔄]+\s*/, "")
    return (
      <Text color={c.text3} fontSize="$2" flex={1}>
        {messageWithoutEmoji}
      </Text>
    )
  }

  // The quiet system line (`.sys`): codenote EVENT · message · type glyph.
  return (
    <XStack
      width="100%"
      paddingVertical={8}
      paddingHorizontal={12}
      backgroundColor={c.wash}
      borderRadius={12}
      alignItems="center"
      gap={8}
    >
      {/* Left section: EVENT badge */}
      <XStack gap={6} alignItems="center">
        <T step="codenote" tone="text3">
          {t("conversation.events.eventLabel")}
        </T>
        <T step="codenote" tone="text3">
          ·
        </T>
      </XStack>

      {/* Center: Message with agent badge */}
      {renderMessage()}

      {/* Right section: Event type label + icon */}
      <XStack gap={6} alignItems="center">
        <T step="codenote" tone="text3">
          {label}
        </T>
        {icon}
      </XStack>
    </XStack>
  )
}
