import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useImageWithFallback } from '../hooks/useImageWithFallback';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors } from './mca/primitives/colors';

interface Agent {
  agentId: string;
  name: string;
  avatarUrl?: string;
}

interface AgentAvatarStackProps {
  agents: Agent[];
  maxVisible?: number;
  size?: number;
}

/**
 * Single avatar within the stack. Owns its own error state so a 404 falls back
 * to the initial instead of the broken-image glyph (one state per agent — hooks
 * can't live inside the parent's .map()).
 */
function StackAvatar({ agent, size }: { agent: Agent; size: number }) {
  const firstName = agent.name.split(' ')[0];
  const { showImage, onError } = useImageWithFallback(agent.avatarUrl);
  const c = useColors();

  if (showImage) {
    return (
      <Image
        source={{ uri: agent.avatarUrl }}
        style={[styles.avatar, { width: size, height: size, borderRadius: size / 4 }]}
        onError={onError}
      />
    );
  }

  return (
    <View
      style={[
        styles.avatarPlaceholder,
        {
          width: size,
          height: size,
          borderRadius: size / 4,
          backgroundColor: semanticColors.indigoGlow,
          borderColor: c.border,
        },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.5, color: semanticColors.indigo }]}>
        {firstName.charAt(0)}
      </Text>
    </View>
  );
}

export function AgentAvatarStack({ agents, maxVisible = 5, size = 18 }: AgentAvatarStackProps) {
  if (agents.length === 0) return null;

  const c = useColors();
  const visibleAgents = agents.slice(0, maxVisible);
  const remainingCount = agents.length - maxVisible;
  const overlap = size * 0.12; // 12% overlap

  return (
    <View style={styles.container}>
      {visibleAgents.map((agent, index) => {
        return (
          <View
            key={agent.agentId}
            style={[
              styles.avatarWrapper,
              {
                width: size,
                height: size,
                borderRadius: size / 4,
                marginLeft: index === 0 ? 0 : -overlap,
                zIndex: visibleAgents.length - index,
                borderColor: c.bgPage,
                backgroundColor: c.bgPage,
              },
            ]}
          >
            <StackAvatar agent={agent} size={size} />
          </View>
        );
      })}

      {remainingCount > 0 && (
        <View
          style={[
            styles.countBadge,
            {
              minWidth: size,
              borderRadius: size / 4,
              marginLeft: -overlap,
              paddingVertical: 3,
              marginTop: 2,
              marginRight: -overlap,
              backgroundColor: c.bgCardHover,
              borderColor: c.bgPage,
            },
          ]}
        >
          <Text style={[styles.countText, { fontSize: size * 0.5, color: semanticColors.indigo }]}>
            +{remainingCount}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarWrapper: {
    borderWidth: 1.5,
  },
  avatar: {
    resizeMode: 'cover',
  },
  avatarPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
  },
  avatarText: {
    fontWeight: '500',
  },
  countBadge: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
  },
  countText: {
    fontWeight: '600',
  },
});
