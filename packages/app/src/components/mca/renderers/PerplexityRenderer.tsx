/**
 * Perplexity MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Perplexity AI search and chat.
 * Renders search results with sources, citations, and model info.
 *
 * Design features:
 * - Perplexity logo icon in brand teal (passed via iconUri/PerplexityIcon)
 * - Query preview and source count badge in header
 * - Citations with brand teal accent
 * - Sources list with domains
 *
 * Migrated to compose with `<ToolCallCard>` global (no local HeaderRow).
 */

import { ToolCallCard, useColors } from '../primitives';
import type React from 'react';
import { ScrollView } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Colors — Renderer UX Guide v2 §5.
// ============================================================================
// Theme-adaptive palette. Brand teals + status hex are theme-agnostic;
// surface/text/border come from `useColors()` and switch on theme.

function usePerplexityColors() {
  const c = useColors();
  return {
    // Perplexity brand (theme-agnostic)
    perplexity: '#5BB8C5', // Lightened teal for visibility
    perplexityDark: '#20808D', // Original brand teal

    // Badges (theme-adaptive via useColors().badges + perplexity teal accent)
    badgeTeal: { text: '#5eead4', bg: 'rgba(32,128,141,0.2)' },
    badgeBlue: c.badges.info,
    badgeRed: c.badges.err,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    bgInnerDark: c.bgInner,
    border: c.border,
  };
}

// ============================================================================
// Perplexity Icon Component
// ============================================================================

function PerplexityIcon({ size = 16 }: { size?: number }) {
  const colors = usePerplexityColors();
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

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function parseOutput(output?: string): any {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return { text: output };
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

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

function getAnswerText(text: string): string {
  const parts = text.split('**Sources:**');
  return parts[0].trim();
}

// ============================================================================
// Shared Components
// ============================================================================

type BadgeVariant = 'teal' | 'blue' | 'red' | 'gray';

interface BadgeProps {
  text: string;
  variant: BadgeVariant;
}

function Badge({ text, variant }: BadgeProps) {
  const c = useColors();
  const colors = usePerplexityColors();
  const colorMap = {
    teal: colors.badgeTeal,
    blue: colors.badgeBlue,
    red: colors.badgeRed,
    gray: c.badges.gray,
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

// ============================================================================
// Sub-Renderers
// ============================================================================

// --- Search Renderer ---

function SearchRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useColors();
  const colors = usePerplexityColors();
  const query = input?.query || '';
  const model = input?.model || 'sonar';
  const parsedOutput = parseOutput(output);

  const text = typeof parsedOutput === 'string' ? parsedOutput : parsedOutput?.text || output || '';
  const sources = parseSources(text);
  const answerText = getAnswerText(text);

  const badge =
    status === 'failed'
      ? <Badge text="failed" variant="red" />
      : sources.length > 0
        ? <Badge text={`${sources.length} sources`} variant="teal" />
        : status === 'completed'
          ? <Badge text={model} variant="teal" />
          : null;

  return (
    <ToolCallCard
      status={status}
      description={`Search: ${truncate(query, 40)}`}
      badge={badge}
      iconUri={appIcon}
    >
      {/* Query */}
      <YStack
        backgroundColor={c.bgInner}
        borderRadius={5}
        padding={8}
        paddingHorizontal={10}
        marginBottom={8}
      >
        <Text color={c.text3} fontSize={9} marginBottom={4}>
          Query
        </Text>
        <Text color={c.text} fontSize={11} fontFamily="$mono">
          {query}
        </Text>
      </YStack>

      {/* Answer */}
      {status === 'running' ? (
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={5}
          padding={10}
          marginBottom={8}
          gap={6}
        >
          {[100, 95, 88, 60].map((width, idx) => (
            <YStack
              key={idx}
              backgroundColor={c.border}
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
            backgroundColor: c.bgInner,
            borderRadius: 5,
            marginBottom: 8,
          }}
        >
          <YStack padding={10}>
            <Text color={c.text2} fontSize={11} lineHeight={16}>
              {truncate(answerText, 800)}
            </Text>
          </YStack>
        </ScrollView>
      ) : null}

      {/* Sources */}
      {sources.length > 0 && (
        <YStack backgroundColor={c.bgInner} borderRadius={5} overflow="hidden">
          <XStack
            alignItems="center"
            gap={6}
            padding={6}
            paddingHorizontal={10}
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.3}>
              Sources
            </Text>
            <XStack
              backgroundColor={c.borderStrong}
              paddingHorizontal={4}
              paddingVertical={1}
              borderRadius={2}
            >
              <Text color={c.text3} fontSize={8}>
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
              borderBottomColor={c.border}
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
              <Text flex={1} color={c.text2} fontSize={10} numberOfLines={1}>
                {source.domain}
              </Text>
            </XStack>
          ))}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// --- Chat Renderer ---

function ChatRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useColors();
  const colors = usePerplexityColors();
  const messages = input?.messages || [];
  const model = input?.model || 'sonar';
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const parsedOutput = parseOutput(output);

  const text = typeof parsedOutput === 'string' ? parsedOutput : parsedOutput?.text || output || '';
  const answerText = getAnswerText(text);

  const badge =
    status === 'failed'
      ? <Badge text="failed" variant="red" />
      : <Badge text={model} variant="blue" />;

  return (
    <ToolCallCard
      status={status}
      description={`Chat: ${messageCount} message${messageCount !== 1 ? 's' : ''}`}
      badge={badge}
      iconUri={appIcon}
    >
      {/* Messages preview */}
      <YStack
        backgroundColor={c.bgInner}
        borderRadius={5}
        padding={8}
        paddingHorizontal={10}
        marginBottom={8}
        gap={4}
      >
        <Text color={c.text3} fontSize={9} marginBottom={2}>
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
              <Text color={c.text2} fontSize={10} flex={1} numberOfLines={2}>
                {truncate(msg.content || '', 100)}
              </Text>
            </XStack>
          ))}
      </YStack>

      {/* Response */}
      {status === 'running' ? (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} gap={6}>
          {[100, 95, 88, 60].map((width, idx) => (
            <YStack
              key={idx}
              backgroundColor={c.border}
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
            backgroundColor: c.bgInner,
            borderRadius: 5,
          }}
        >
          <YStack padding={10}>
            <Text color={c.text2} fontSize={11} lineHeight={16}>
              {truncate(answerText, 800)}
            </Text>
          </YStack>
        </ScrollView>
      ) : null}
    </ToolCallCard>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function PerplexityRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);

  switch (shortName) {
    case 'perplexity-search':
      return <SearchRenderer {...props} />;
    case 'perplexity-chat':
      return <ChatRenderer {...props} />;
    default:
      return <SearchRenderer {...props} />;
  }
}

// Suppress unused warnings — kept exported for visual consistency
// (PerplexityIcon used inline in a future revision when ToolCallCard
// supports leading slots beyond iconUri).
void PerplexityIcon;

export const PerplexityToolCallRenderer = withPermissionSupport(PerplexityRendererBase);
export default PerplexityToolCallRenderer;
