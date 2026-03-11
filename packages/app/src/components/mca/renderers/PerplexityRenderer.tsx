/**
 * Perplexity MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Perplexity AI search and chat.
 * Renders search results with sources, citations, and model info.
 *
 * Design features:
 * - Status dot with glow effect (green/cyan/red)
 * - Perplexity logo icon in brand teal
 * - Query preview and source count badge
 * - Collapsed/expanded views with citations
 * - Sources list with domains
 */

import { ChevronRight } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Perplexity brand
  perplexity: '#5BB8C5', // Lightened teal for visibility
  perplexityDark: '#20808D', // Original brand teal

  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeTeal: { text: '#5eead4', bg: 'rgba(32,128,141,0.2)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#a1a1aa',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgInnerDark: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.03)',
  borderLight: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Perplexity Icon Component
// ============================================================================

function PerplexityIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 36" fill="none">
      <Path
        d="m23.566,1.398l-9.495,9.504h9.495V1.398v2.602V1.398Zm-9.496,9.504L4.574,1.398v9.504h9.496Zm-.021-10.902v36m9.517-15.596l-9.495-9.504v13.625l9.495,9.504v-13.625Zm-18.991,0l9.496-9.504v13.625l-9.496,9.504v-13.625ZM.5,10.9v13.57h4.074v-4.066l9.496-9.504H.5Zm13.57,0l9.495,9.504v4.066h4.075v-13.57h-13.57Z"
        fill="none"
        stroke={colors.perplexity}
        strokeMiterlimit={10}
      />
    </Svg>
  );
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract short tool name from full tool name
 * "perplexity_perplexity-search" -> "perplexity-search"
 */
function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Parse JSON output safely
 */
function parseOutput(output?: string): any {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return { text: output };
  }
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Parse sources from output text
 * Sources appear as "**Sources:**\n1. url\n2. url..."
 */
function parseSources(text: string): { num: number; url: string; domain: string }[] {
  const sources: { num: number; url: string; domain: string }[] = [];
  const sourcesMatch = text.match(/\*\*Sources:\*\*\n([\s\S]*?)$/);

  if (sourcesMatch) {
    const lines = sourcesMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s+(https?:\/\/[^\s]+)/);
      if (match) {
        sources.push({
          num: parseInt(match[1], 10),
          url: match[2],
          domain: extractDomain(match[2]),
        });
      }
    }
  }

  return sources;
}

/**
 * Get answer text (everything before **Sources:**)
 */
function getAnswerText(text: string): string {
  const parts = text.split('**Sources:**');
  return parts[0].trim();
}

// ============================================================================
// Shared Components
// ============================================================================

interface StatusDotProps {
  status: 'running' | 'completed' | 'failed';
}

function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' ? colors.running : status === 'completed' ? colors.success : colors.failed;

  const glow =
    status === 'running'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

interface BadgeProps {
  text: string;
  variant: 'teal' | 'blue' | 'red' | 'gray';
}

function Badge({ text, variant }: BadgeProps) {
  const colorMap = {
    teal: colors.badgeTeal,
    blue: colors.badgeBlue,
    red: colors.badgeRed,
    gray: colors.badgeGray,
  };

  const { text: textColor, bg } = colorMap[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={5} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeProps['variant'] };
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : colors.borderLight}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.borderLight}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />

      <PerplexityIcon size={16} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          searching
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge && <Badge text={badge.text} variant={badge.variant} />}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.borderLight}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

function ExpandedBody({ children }: { children: React.ReactNode }) {
  return <YStack padding={8}>{children}</YStack>;
}

// ============================================================================
// Citation Component
// ============================================================================

function Citation({ num }: { num: number }) {
  return (
    <XStack
      backgroundColor="rgba(32,128,141,0.2)"
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
      marginLeft={2}
    >
      <Text color={colors.perplexity} fontSize={8} fontWeight="600">
        {num}
      </Text>
    </XStack>
  );
}

// ============================================================================
// Sub-Renderers
// ============================================================================

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

// --- Search Renderer ---

function SearchRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const query = input?.query || '';
  const model = input?.model || 'sonar';
  const parsedOutput = parseOutput(output);

  const text = typeof parsedOutput === 'string' ? parsedOutput : parsedOutput?.text || output || '';
  const sources = parseSources(text);
  const answerText = getAnswerText(text);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : sources.length > 0
        ? { text: `${sources.length} sources`, variant: 'teal' as const }
        : status === 'completed'
          ? { text: model, variant: 'teal' as const }
          : undefined;

  const headerProps = {
    status,
    description: `Search: ${truncate(query, 40)}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Query */}
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={5}
          padding={8}
          paddingHorizontal={10}
          marginBottom={8}
        >
          <Text color={colors.muted} fontSize={9} marginBottom={4}>
            Query
          </Text>
          <Text color={colors.bright} fontSize={11} fontFamily="$mono">
            {query}
          </Text>
        </YStack>

        {/* Answer */}
        {status === 'running' ? (
          <YStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            padding={10}
            marginBottom={8}
            gap={6}
          >
            {[100, 95, 88, 60].map((width, idx) => (
              <YStack
                key={idx}
                backgroundColor="rgba(255,255,255,0.04)"
                height={10}
                width={`${width}%`}
                borderRadius={4}
              />
            ))}
          </YStack>
        ) : status === 'failed' ? (
          <YStack
            backgroundColor="rgba(239,68,68,0.1)"
            borderRadius={5}
            padding={10}
            marginBottom={8}
          >
            <Text color={colors.badgeRed.text} fontSize={10}>
              {error || 'Search failed'}
            </Text>
          </YStack>
        ) : answerText ? (
          <ScrollView
            style={{
              maxHeight: 200,
              backgroundColor: colors.bgInner,
              borderRadius: 5,
              marginBottom: 8,
            }}
          >
            <YStack padding={10}>
              <Text color={colors.secondary} fontSize={11} lineHeight={16}>
                {truncate(answerText, 800)}
              </Text>
            </YStack>
          </ScrollView>
        ) : null}

        {/* Sources */}
        {sources.length > 0 && (
          <YStack backgroundColor="rgba(0,0,0,0.15)" borderRadius={5} overflow="hidden">
            <XStack
              alignItems="center"
              gap={6}
              padding={6}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
            >
              <Text color={colors.muted} fontSize={9} textTransform="uppercase" letterSpacing={0.3}>
                Sources
              </Text>
              <XStack
                backgroundColor="rgba(255,255,255,0.06)"
                paddingHorizontal={4}
                paddingVertical={1}
                borderRadius={2}
              >
                <Text color="#71717a" fontSize={8}>
                  {sources.length}
                </Text>
              </XStack>
              <XStack flex={1} />
              <XStack
                backgroundColor="rgba(32,128,141,0.15)"
                paddingHorizontal={6}
                paddingVertical={2}
                borderRadius={3}
              >
                <Text color={colors.perplexity} fontSize={9}>
                  {model}
                </Text>
              </XStack>
            </XStack>

            {sources.slice(0, 5).map((source, idx) => (
              <XStack
                key={source.num}
                alignItems="center"
                gap={8}
                padding={6}
                paddingHorizontal={10}
                borderBottomWidth={idx < Math.min(sources.length, 5) - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={16}
                  height={16}
                  backgroundColor="rgba(32,128,141,0.15)"
                  borderRadius={3}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Text color={colors.perplexity} fontSize={9} fontWeight="600">
                    {source.num}
                  </Text>
                </XStack>
                <Text flex={1} color={colors.secondary} fontSize={10} numberOfLines={1}>
                  {source.domain}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Chat Renderer ---

function ChatRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const messages = input?.messages || [];
  const model = input?.model || 'sonar';
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const parsedOutput = parseOutput(output);

  const text = typeof parsedOutput === 'string' ? parsedOutput : parsedOutput?.text || output || '';
  const sources = parseSources(text);
  const answerText = getAnswerText(text);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : { text: model, variant: 'blue' as const };

  const headerProps = {
    status,
    description: `Chat: ${messageCount} message${messageCount !== 1 ? 's' : ''}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Messages preview */}
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={5}
          padding={8}
          paddingHorizontal={10}
          marginBottom={8}
          gap={4}
        >
          <Text color={colors.muted} fontSize={9} marginBottom={2}>
            Conversation ({messageCount} messages)
          </Text>
          {Array.isArray(messages) &&
            messages.slice(-2).map((msg: any, idx: number) => (
              <XStack key={idx} gap={6} alignItems="flex-start">
                <Text
                  color={msg.role === 'user' ? colors.badgeBlue.text : colors.badgeTeal.text}
                  fontSize={9}
                  width={45}
                  flexShrink={0}
                >
                  {msg.role}
                </Text>
                <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={2}>
                  {truncate(msg.content || '', 100)}
                </Text>
              </XStack>
            ))}
        </YStack>

        {/* Response */}
        {status === 'running' ? (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10} gap={6}>
            {[100, 95, 88, 60].map((width, idx) => (
              <YStack
                key={idx}
                backgroundColor="rgba(255,255,255,0.04)"
                height={10}
                width={`${width}%`}
                borderRadius={4}
              />
            ))}
          </YStack>
        ) : status === 'failed' ? (
          <YStack backgroundColor="rgba(239,68,68,0.1)" borderRadius={5} padding={10}>
            <Text color={colors.badgeRed.text} fontSize={10}>
              {error || 'Chat failed'}
            </Text>
          </YStack>
        ) : answerText ? (
          <ScrollView
            style={{
              maxHeight: 200,
              backgroundColor: colors.bgInner,
              borderRadius: 5,
            }}
          >
            <YStack padding={10}>
              <Text color={colors.secondary} fontSize={11} lineHeight={16}>
                {truncate(answerText, 800)}
              </Text>
            </YStack>
          </ScrollView>
        ) : null}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function PerplexityRendererBase(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const shortName = getShortToolName(props.toolName);

  const subProps: SubRendererProps = {
    ...props,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  switch (shortName) {
    case 'perplexity-search':
      return <SearchRenderer {...subProps} />;
    case 'perplexity-chat':
      return <ChatRenderer {...subProps} />;
    default:
      return <SearchRenderer {...subProps} />;
  }
}

export const PerplexityToolCallRenderer = withPermissionSupport(PerplexityRendererBase);

// Default export for dynamic import
export default PerplexityToolCallRenderer;
