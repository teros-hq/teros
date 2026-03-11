import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

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

export function AgentAvatarStack({ agents, maxVisible = 5, size = 18 }: AgentAvatarStackProps) {
  if (agents.length === 0) return null;

  const visibleAgents = agents.slice(0, maxVisible);
  const remainingCount = agents.length - maxVisible;
  const overlap = size * 0.12; // 12% overlap

  return (
    <View style={styles.container}>
      {visibleAgents.map((agent, index) => {
        const firstName = agent.name.split(' ')[0];
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
              },
            ]}
          >
            {agent.avatarUrl ? (
              <Image
                source={{ uri: agent.avatarUrl }}
                style={[
                  styles.avatar,
                  {
                    width: size,
                    height: size,
                    borderRadius: size / 4,
                  },
                ]}
              />
            ) : (
              <View
                style={[
                  styles.avatarPlaceholder,
                  {
                    width: size,
                    height: size,
                    borderRadius: size / 4,
                  },
                ]}
              >
                <Text style={[styles.avatarText, { fontSize: size * 0.5 }]}>
                  {firstName.charAt(0)}
                </Text>
              </View>
            )}
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
            },
          ]}
        >
          <Text style={[styles.countText, { fontSize: size * 0.5 }]}>+{remainingCount}</Text>
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
    borderColor: '#0a0a0a',
    backgroundColor: '#0a0a0a',
  },
  avatar: {
    resizeMode: 'cover',
  },
  avatarPlaceholder: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#06B6D4',
    fontWeight: '500',
  },
  countBadge: {
    backgroundColor: '#1D3D42',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#0a0a0a',
  },
  countText: {
    color: '#4A9BA8',
    fontWeight: '600',
  },
});
