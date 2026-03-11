import { Bell, Clock, Pause, RefreshCw } from '@tamagui/lucide-icons';
import { Image } from 'react-native';
import { Text, XStack } from 'tamagui';

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
  // Get icon and event type label based on event type
  const getIconAndLabel = () => {
    switch (eventType) {
      case 'task_update':
        // Determine icon based on running state
        if (eventData.running) {
          return {
            icon: <Clock size={14} color="rgba(255, 255, 255, 0.4)" />,
            label: 'Task Updated',
          };
        } else {
          return {
            icon: <Pause size={14} color="rgba(255, 255, 255, 0.4)" />,
            label: 'Task Updated',
          };
        }
      case 'reminder':
        return {
          icon: <Bell size={14} color="rgba(255, 200, 100, 0.6)" />,
          label: 'Reminder',
        };
      case 'recurring_task':
        return {
          icon: <RefreshCw size={14} color="rgba(255, 255, 255, 0.4)" />,
          label: 'Recurring Task',
        };
      case 'system_resume':
        return {
          icon: <RefreshCw size={14} color="rgba(255, 255, 255, 0.4)" />,
          label: 'System Resume',
        };
      default:
        return {
          icon: <Clock size={14} color="rgba(255, 255, 255, 0.4)" />,
          label: 'Event',
        };
    }
  };

  const { icon, label } = getIconAndLabel();

  // Parse message to extract agent name and create badge
  const renderMessage = () => {
    const message = eventData.message || description || 'System event';
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
              <Text color="rgba(255, 255, 255, 0.5)" fontSize="$2">
                {before}
              </Text>
            )}
            <XStack
              gap="$1.5"
              alignItems="center"
              paddingVertical={2}
              paddingHorizontal={8}
              paddingLeft={2}
              backgroundColor="rgba(255, 255, 255, 0.06)"
              borderRadius={10}
              borderWidth={1}
              borderColor="rgba(255, 255, 255, 0.1)"
            >
              <Image
                source={{ uri: agentAvatar }}
                width={16}
                height={16}
                borderRadius={8}
              />
              <Text
                color="rgba(255, 255, 255, 0.7)"
                fontSize={11}
                fontWeight="500"
              >
                {agentName}
              </Text>
            </XStack>
            {after.length > 0 && (
              <Text color="rgba(255, 255, 255, 0.5)" fontSize="$2">
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
      <Text color="rgba(255, 255, 255, 0.5)" fontSize="$2" flex={1}>
        {messageWithoutEmoji}
      </Text>
    );
  };

  return (
    <XStack
      width="100%"
      paddingVertical="$2"
      paddingHorizontal="$3"
      backgroundColor="rgba(255, 255, 255, 0.03)"
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor="rgba(255, 255, 255, 0.06)"
      alignItems="center"
      gap="$2"
      marginVertical="$1"
    >
      {/* Left section: EVENT badge */}
      <XStack gap="$1.5" alignItems="center">
        <Text
          color="rgba(255, 255, 255, 0.35)"
          fontSize="$1"
          fontWeight="500"
          textTransform="uppercase"
          letterSpacing={1}
        >
          EVENT
        </Text>
        <Text color="rgba(255, 255, 255, 0.5)" fontSize="$2">
          •
        </Text>
      </XStack>

      {/* Center: Message with agent badge */}
      {renderMessage()}

      {/* Right section: Event type label + icon */}
      <XStack gap="$1.5" alignItems="center">
        <Text
          color="rgba(255, 255, 255, 0.3)"
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
