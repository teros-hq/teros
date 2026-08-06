import { Bell, CheckCircle, Clock, ExternalLink, Lock, Pause, RefreshCw, XCircle } from '@tamagui/lucide-icons';
import { useTranslation } from 'react-i18next';
import { Image } from 'react-native';
import { Text, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { useTilingStore } from '../../../store/tilingStore';

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
  eventType: string;
  eventData: Record<string, any>;
  description?: string;
  timestamp: Date;
  showTimestamp?: boolean;
}) {
  const { t } = useTranslation()
  const c = useColors();
  const openWindow = useTilingStore((s) => s.openWindow);
  const getIconAndLabel = () => {
    switch (eventType) {
      case 'channel_started':
        return { icon: <Clock size={14} color={c.text3} />, label: t('conversation.events.started') };
      case 'channel_finished':
        return { icon: <CheckCircle size={14} color="rgba(34,197,94,0.5)" />, label: t('conversation.events.finished') };
      case 'task_update':
        return eventData.running
          ? { icon: <Clock size={14} color={c.text3} />, label: t('conversation.events.taskUpdated') }
          : { icon: <Pause size={14} color={c.text3} />, label: t('conversation.events.taskUpdated') };
      case 'reminder':
        return { icon: <Bell size={14} color="rgba(255,200,100,0.6)" />, label: t('conversation.events.reminder') };
      case 'recurring_task':
        return { icon: <RefreshCw size={14} color={c.text3} />, label: t('conversation.events.recurringTask') };
      case 'system_resume':
        return { icon: <RefreshCw size={14} color={c.text3} />, label: t('conversation.events.systemResume') };
      default:
        return { icon: <Clock size={14} color={c.text3} />, label: t('conversation.events.event') };
    }
  };

  const { icon, label } = getIconAndLabel();

  // ------------------------------------------------------------------
  // channel_permission — observed channel needs approval
  // ------------------------------------------------------------------
  if (eventType === 'channel_permission') {
    const { observedChannelId, observedChannelName, toolName } = eventData;
    const shortTool = toolName ? String(toolName).split('_').pop() : 'tool';
    return (
      <XStack
        width="100%"
        paddingVertical="$2"
        paddingHorizontal="$3"
        backgroundColor="rgba(251,191,36,0.05)"
        borderTopWidth={1}
        borderBottomWidth={1}
        borderColor="rgba(251,191,36,0.15)"
        alignItems="center"
        gap="$2"
        marginVertical="$1"
      >
        <Lock size={13} color="rgba(251,191,36,0.7)" />
        <YStack flex={1} gap={1}>
          <Text color="rgba(251,191,36,0.9)" fontSize={11} fontWeight="500">
            {t('conversation.events.needsApproval', { channel: observedChannelName || t('conversation.events.observedChannel') })}
          </Text>
          <Text color={c.text3} fontSize={10}>
            {t('conversation.events.tool', { tool: shortTool })}
          </Text>
        </YStack>
        {observedChannelId && (
          <XStack
            paddingHorizontal={8}
            paddingVertical={4}
            borderRadius={4}
            backgroundColor="rgba(251,191,36,0.12)"
            borderWidth={1}
            borderColor="rgba(251,191,36,0.25)"
            alignItems="center"
            gap={4}
            cursor="pointer"
            hoverStyle={{ backgroundColor: 'rgba(251,191,36,0.2)' }}
            onPress={() => openWindow('chat', { channelId: observedChannelId }, true)}
          >
            <ExternalLink size={11} color="rgba(251,191,36,0.8)" />
            <Text color="rgba(251,191,36,0.9)" fontSize={10} fontWeight="500">
              {t('conversation.events.goToApprove')}
            </Text>
          </XStack>
        )}
      </XStack>
    );
  }

  // ------------------------------------------------------------------
  // channel_finished — sub-channel finished its turn (TER-352 / TER-461)
  // Acepta los dos shapes de emisor: ruta interna (observedChannel*, vía
  // message-handler.emitTurnEvent / complete-my-task) y ruta MCA
  // event-subscription (channel*, payload crudo del topic channel:turn_end).
  // ------------------------------------------------------------------
  if (eventType === 'channel_finished') {
    const channelId = eventData.observedChannelId ?? eventData.channelId;
    const channelName = eventData.observedChannelName ?? eventData.channelName;
    return (
      <XStack
        width="100%"
        paddingVertical="$2"
        paddingHorizontal="$3"
        backgroundColor="rgba(34,197,94,0.04)"
        borderTopWidth={1}
        borderBottomWidth={1}
        borderColor="rgba(34,197,94,0.12)"
        alignItems="center"
        gap="$2"
        marginVertical="$1"
      >
        <CheckCircle size={13} color="rgba(34,197,94,0.7)" />
        <Text color="rgba(34,197,94,0.85)" fontSize={11} flex={1}>
          {t('conversation.events.channelFinished', { channel: channelName || channelId })}
        </Text>
        {channelId && (
          <XStack
            paddingHorizontal={8}
            paddingVertical={4}
            borderRadius={4}
            backgroundColor="rgba(34,197,94,0.10)"
            borderWidth={1}
            borderColor="rgba(34,197,94,0.22)"
            alignItems="center"
            gap={4}
            cursor="pointer"
            hoverStyle={{ backgroundColor: 'rgba(34,197,94,0.18)' }}
            onPress={() => openWindow('chat', { channelId }, true)}
          >
            <ExternalLink size={11} color="rgba(34,197,94,0.8)" />
            <Text color="rgba(34,197,94,0.9)" fontSize={10} fontWeight="500">
              {t('conversation.events.open')}
            </Text>
          </XStack>
        )}
      </XStack>
    );
  }

  // ------------------------------------------------------------------
  // channel_resolved — permission approved or denied
  // ------------------------------------------------------------------
  if (eventType === 'channel_resolved') {
    const { observedChannelName, toolName, resolution } = eventData;
    const shortTool = toolName ? String(toolName).split('_').pop() : 'tool';
    const isGranted = resolution === 'granted';
    return (
      <XStack
        width="100%"
        paddingVertical="$2"
        paddingHorizontal="$3"
        backgroundColor={isGranted ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)'}
        borderTopWidth={1}
        borderBottomWidth={1}
        borderColor={isGranted ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'}
        alignItems="center"
        gap="$2"
        marginVertical="$1"
      >
        {isGranted
          ? <CheckCircle size={13} color="rgba(34,197,94,0.7)" />
          : <XCircle size={13} color="rgba(239,68,68,0.7)" />}
        <Text color={isGranted ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)'} fontSize={11} flex={1}>
          {isGranted
            ? t('conversation.events.approved', { channel: observedChannelName, tool: shortTool })
            : t('conversation.events.denied', { channel: observedChannelName, tool: shortTool })}
        </Text>
      </XStack>
    );
  }

  // ------------------------------------------------------------------
  // permission_timeout — HISTORICAL only. The auto-deny countdown was
  // removed (requests now wait indefinitely); this renderer stays so
  // old persisted events in channel history still display correctly.
  // ------------------------------------------------------------------
  if (eventType === 'permission_timeout') {
    const { toolName } = eventData;
    const shortTool = toolName ? String(toolName).split('_').pop() : 'tool';
    return (
      <XStack
        width="100%"
        paddingVertical="$2"
        paddingHorizontal="$3"
        backgroundColor={c.bgInner}
        borderTopWidth={1}
        borderBottomWidth={1}
        borderColor={c.border}
        alignItems="center"
        gap="$2"
        marginVertical="$1"
      >
        <Clock size={13} color={c.text3} />
        <YStack flex={1} gap={1}>
          <Text color={c.text2} fontSize={11} fontWeight="500">
            {t('conversation.events.permissionTimedOut')}
          </Text>
          <Text color={c.text3} fontSize={10}>
            {t('conversation.events.autodenied', { tool: shortTool })}
          </Text>
        </YStack>
      </XStack>
    );
  }

  // ------------------------------------------------------------------
  // channel_started — sub-channel started working
  // ------------------------------------------------------------------
  if (eventType === 'channel_started') {
    // Acepta los dos shapes de emisor: ruta interna (observedChannel*) y
    // ruta MCA event-subscription (channel*). Ver channel_finished.
    const channelId = eventData.observedChannelId ?? eventData.channelId;
    const channelName = eventData.observedChannelName ?? eventData.channelName;
    return (
      <XStack
        width="100%"
        paddingVertical="$2"
        paddingHorizontal="$3"
        backgroundColor="rgba(94,106,210,0.04)"
        borderTopWidth={1}
        borderBottomWidth={1}
        borderColor="rgba(94,106,210,0.12)"
        alignItems="center"
        gap="$2"
        marginVertical="$1"
      >
        <Clock size={13} color="rgba(94,106,210,0.7)" />
        <Text color="rgba(94,106,210,0.85)" fontSize={11} flex={1}>
          {t('conversation.events.channelStarted', { channel: channelName || channelId })}
        </Text>
        {channelId && (
          <XStack
            paddingHorizontal={8}
            paddingVertical={4}
            borderRadius={4}
            backgroundColor="rgba(94,106,210,0.10)"
            borderWidth={1}
            borderColor="rgba(94,106,210,0.22)"
            alignItems="center"
            gap={4}
            cursor="pointer"
            hoverStyle={{ backgroundColor: 'rgba(94,106,210,0.18)' }}
            onPress={() => openWindow('chat', { channelId }, true)}
          >
            <ExternalLink size={11} color="rgba(94,106,210,0.8)" />
            <Text color="rgba(94,106,210,0.9)" fontSize={10} fontWeight="500">
              {t('conversation.events.open')}
            </Text>
          </XStack>
        )}
      </XStack>
    );
  }

  // Parse message to extract agent name and create badge
  const renderMessage = () => {
    const message = eventData.message || description || t('conversation.events.systemEvent');
    const agentName = eventData.agentName;
    const agentAvatar = eventData.agentAvatar;

    // If we have agent info, render message with agent badge
    if (agentName && agentAvatar) {
      // Split message to insert agent badge
      // Common patterns: "Nira started...", "Task assigned to Nira", "Nira created..."
      const messageWithoutEmoji = message.replace(/^[🔄⏸️📋⏰🔄]+\s*/, '');

      // Try to find agent name in message and replace with badge
      const agentNameIndex = messageWithoutEmoji.indexOf(agentName);

      if (agentNameIndex !== -1) {
        const before = messageWithoutEmoji.substring(0, agentNameIndex);
        const after = messageWithoutEmoji.substring(agentNameIndex + agentName.length);

        return (
          <XStack gap="$1.5" alignItems="center" flexWrap="wrap" flex={1}>
            {before.length > 0 && (
              <Text color={c.text3} fontSize="$2">
                {before}
              </Text>
            )}
            <XStack
              gap="$1.5"
              alignItems="center"
              paddingVertical={2}
              paddingHorizontal={8}
              paddingLeft={2}
              backgroundColor={c.border}
              borderRadius={10}
              borderWidth={1}
              borderColor={c.border}
            >
              <Image
                source={{ uri: agentAvatar }}
                width={16}
                height={16}
                borderRadius={8}
              />
              <Text
                color={c.text2}
                fontSize={11}
                fontWeight="500"
              >
                {agentName}
              </Text>
            </XStack>
            {after.length > 0 && (
              <Text color={c.text3} fontSize="$2">
                {after}
              </Text>
            )}
          </XStack>
        );
      }
    }

    // Fallback: render plain message without emoji
    const messageWithoutEmoji = message.replace(/^[🔄⏸️📋⏰🔄]+\s*/, '');
    return (
      <Text color={c.text3} fontSize="$2" flex={1}>
        {messageWithoutEmoji}
      </Text>
    );
  };

  return (
    <XStack
      width="100%"
      paddingVertical="$2"
      paddingHorizontal="$3"
      backgroundColor={c.bgInner}
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor={c.border}
      alignItems="center"
      gap="$2"
      marginVertical="$1"
    >
      {/* Left section: EVENT badge */}
      <XStack gap="$1.5" alignItems="center">
        <Text
          color={c.text3}
          fontSize="$1"
          fontWeight="500"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {t('conversation.events.eventLabel')}
        </Text>
        <Text color={c.text3} fontSize="$2">
          •
        </Text>
      </XStack>

      {/* Center: Message with agent badge */}
      {renderMessage()}

      {/* Right section: Event type label + icon */}
      <XStack gap="$1.5" alignItems="center">
        <Text
          color={c.text3}
          fontSize="$1"
          fontWeight="500"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {label}
        </Text>
        {icon}
      </XStack>
    </XStack>
  );
}
