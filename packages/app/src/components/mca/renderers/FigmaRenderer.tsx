/**
 * Figma MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Figma API tool calls.
 * Renders design operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Design based on Gmail renderer with:
 * - Status dot with glow effect
 * - Figma icon
 * - Contextual badges (count, exported, colors, etc.)
 * - Collapsed/expanded views
 * - Smooth animations
 */

import {
  ChevronRight,
  File,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Palette,
  Type,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// Figma icon from backend static
const FIGMA_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/figma-icon.svg`;

// Figma brand colors
const FIGMA_COLORS = {
  red: '#f24e1e',
  orange: '#ff7262',
  purple: '#a259ff',
  blue: '#1abcfe',
  green: '#0acf83',
};

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },
  badgeGreen: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeYellow: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },
  badgeCyan: { text: '#67e8f9', bg: 'rgba(6,182,212,0.1)' },
  badgeOrange: { text: '#fdba74', bg: 'rgba(251,146,60,0.1)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#a1a1aa',
  muted: '#52525b',
  bright: '#e4e4e7',
  white: '#fafafa',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgInnerDark: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.03)',
  borderLight: 'rgba(255,255,255,0.05)',

  // Figma specific
  figmaPurple: '#a259ff',
  figmaBlue: '#1abcfe',
  figmaGreen: '#0acf83',
  figmaRed: '#f24e1e',
  figmaOrange: '#ff7262',
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract short tool name from full tool name
 * "figma_figma-get-file" -> "figma-get-file"
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
function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
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
 * Get node type icon color based on type
 */
function getNodeTypeColor(type: string): string {
  switch (type?.toUpperCase()) {
    case 'FRAME':
    case 'GROUP':
      return colors.figmaPurple;
    case 'COMPONENT':
    case 'COMPONENT_SET':
      return colors.figmaGreen;
    case 'INSTANCE':
      return colors.figmaBlue;
    case 'TEXT':
      return colors.figmaOrange;
    case 'VECTOR':
    case 'RECTANGLE':
    case 'ELLIPSE':
      return colors.figmaRed;
    default:
      return colors.secondary;
  }
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
        // Shadow for glow effect
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
  variant: 'gray' | 'green' | 'blue' | 'yellow' | 'red' | 'purple' | 'cyan' | 'orange';
}

function Badge({ text, variant }: BadgeProps) {
  const colorMap = {
    gray: colors.badgeGray,
    green: colors.badgeGreen,
    blue: colors.badgeBlue,
    yellow: colors.badgeYellow,
    red: colors.badgeRed,
    purple: colors.badgePurple,
    cyan: colors.badgeCyan,
    orange: colors.badgeOrange,
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

/** Figma logo as inline SVG-like component using colored squares */
function FigmaIcon({ size = 16 }: { size?: number }) {
  const unitSize = size / 3;
  return (
    <YStack width={size} height={size * 1.5} gap={0}>
      <XStack>
        <XStack
          width={unitSize}
          height={unitSize}
          backgroundColor={FIGMA_COLORS.red}
          borderTopLeftRadius={unitSize / 2}
        />
        <XStack
          width={unitSize}
          height={unitSize}
          backgroundColor={FIGMA_COLORS.orange}
          borderTopRightRadius={unitSize / 2}
        />
      </XStack>
      <XStack>
        <XStack width={unitSize} height={unitSize} backgroundColor={FIGMA_COLORS.purple} />
        <XStack
          width={unitSize}
          height={unitSize}
          backgroundColor={FIGMA_COLORS.blue}
          borderRadius={unitSize / 2}
        />
      </XStack>
      <XStack>
        <XStack
          width={unitSize}
          height={unitSize}
          backgroundColor={FIGMA_COLORS.green}
          borderBottomLeftRadius={unitSize / 2}
          borderBottomRightRadius={unitSize / 2}
        />
      </XStack>
    </YStack>
  );
}

/** Figma logo from static assets */
function FigmaIconSimple() {
  return <Image source={{ uri: FIGMA_ICON }} width={14} height={14} resizeMode="contain" />;
}

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeProps['variant'] };
  expanded: boolean;
  onToggle: () => void;
  /** Whether this is inside an expanded container (different border radius) */
  isInContainer?: boolean;
  /** Optional icon to show instead of Figma icon */
  icon?: React.ReactNode;
}

function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
  icon,
}: HeaderRowProps) {
  // Rotation animation for chevron
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
      backgroundColor="transparent"
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : 'rgba(255,255,255,0.04)'}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={isInContainer ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.04)'}
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

      {icon || <FigmaIconSimple />}

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          loading
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
        <ChevronRight size={10} color="#3f3f46" />
      </Animated.View>
    </XStack>
  );
}

/** Wrapper for expanded state - contains header + body */
interface ExpandedContainerProps {
  children: React.ReactNode;
}

function ExpandedContainer({ children }: ExpandedContainerProps) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor="rgba(255,255,255,0.04)"
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

/** Body wrapper for expanded content */
interface ExpandedBodyProps {
  children: React.ReactNode;
}

function ExpandedBody({ children }: ExpandedBodyProps) {
  return <YStack padding={8}>{children}</YStack>;
}

// ============================================================================
// Output Types
// ============================================================================

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

interface FigmaFile {
  name: string;
  lastModified: string;
  version: string;
  document?: FigmaNode;
  pages?: FigmaNode[];
}

interface FigmaComponent {
  key: string;
  name: string;
  description?: string;
  node_id?: string;
  containing_frame?: { name: string };
}

interface FigmaStyle {
  key: string;
  name: string;
  style_type: string;
  description?: string;
}

interface FigmaComment {
  id: string;
  message: string;
  user?: { handle: string };
  created_at?: string;
  resolved_at?: string;
}

interface FigmaProject {
  id: string;
  name: string;
}

interface FigmaProjectFile {
  key: string;
  name: string;
  thumbnail_url?: string;
  last_modified?: string;
}

interface ColorValue {
  hex: string;
  name?: string;
  opacity?: number;
}

interface TypographyValue {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  lineHeight?: number | string;
  letterSpacing?: number;
}

interface ExportedImage {
  nodeId: string;
  url: string;
  format?: string;
}

// ============================================================================
// Sub-Renderers
// ============================================================================

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

// --- Get File ---

function GetFileRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<FigmaFile>(output);
  const fileKey = input?.fileKey || '';

  const pageCount = data?.pages?.length || data?.document?.children?.length || 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : pageCount > 0
        ? { text: `${pageCount} pages`, variant: 'purple' as const }
        : undefined;

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: data?.name ? `File: ${truncate(data.name, 30)}` : 'Get file structure',
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
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10} alignItems="center" gap={6}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : data ? (
            <YStack>
              {/* File info */}
              <XStack
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={1}
                borderBottomColor={colors.border}
              >
                <File size={12} color={colors.figmaPurple} />
                <Text color={colors.bright} fontSize={10} fontWeight="500" flex={1}>
                  {data.name || 'Untitled'}
                </Text>
                {data.version && (
                  <Text color={colors.muted} fontSize={9} fontFamily="$mono">
                    v{data.version}
                  </Text>
                )}
              </XStack>

              {/* Pages list */}
              {(data.pages || data.document?.children)?.slice(0, 8).map((page, idx) => (
                <XStack
                  key={page.id || idx}
                  paddingVertical={5}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={
                    idx < (data.pages || data.document?.children || []).length - 1 ? 1 : 0
                  }
                  borderBottomColor={colors.border}
                >
                  <Layers size={10} color={colors.secondary} />
                  <Text color={colors.secondary} fontSize={10} flex={1} numberOfLines={1}>
                    {page.name}
                  </Text>
                  <Text color={colors.muted} fontSize={9} fontFamily="$mono">
                    {page.type}
                  </Text>
                </XStack>
              ))}
            </YStack>
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                Loading file...
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Node ---

function GetNodeRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ nodes: Record<string, { document: FigmaNode }> }>(output);
  const nodeId = input?.nodeId || '';

  // Extract the first node from the response
  const nodeData = data?.nodes ? Object.values(data.nodes)[0]?.document : null;
  const childCount = nodeData?.children?.length || 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : nodeData?.type
        ? { text: nodeData.type, variant: 'cyan' as const }
        : undefined;

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: nodeData?.name ? `Node: ${truncate(nodeData.name, 25)}` : 'Get node details',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {status === 'failed' ? (
            <Text color={colors.badgeRed.text} fontSize={10}>
              {displayError || 'Unknown error'}
            </Text>
          ) : nodeData ? (
            <>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={40}>
                  Name
                </Text>
                <Text
                  color={colors.bright}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {nodeData.name}
                </Text>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={40}>
                  Type
                </Text>
                <XStack
                  backgroundColor={`${getNodeTypeColor(nodeData.type)}20`}
                  paddingHorizontal={5}
                  paddingVertical={1}
                  borderRadius={3}
                >
                  <Text color={getNodeTypeColor(nodeData.type)} fontSize={9} fontFamily="$mono">
                    {nodeData.type}
                  </Text>
                </XStack>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={40}>
                  ID
                </Text>
                <Text
                  color={colors.secondary}
                  fontSize={9}
                  fontFamily="$mono"
                  flex={1}
                  numberOfLines={1}
                >
                  {nodeData.id || nodeId}
                </Text>
              </XStack>
              {childCount > 0 && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={40}>
                    Children
                  </Text>
                  <Text color={colors.secondary} fontSize={10}>
                    {childCount} nodes
                  </Text>
                </XStack>
              )}
            </>
          ) : (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9}>
                Node ID:
              </Text>
              <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                {nodeId || '(unknown)'}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Components ---

function GetComponentsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{
    meta?: { components?: FigmaComponent[] };
    components?: FigmaComponent[];
  }>(output);
  const components = data?.meta?.components || data?.components || [];
  const count = components.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} components`, variant: 'green' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'List components',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : components.length > 0 ? (
            components.slice(0, 10).map((comp, idx) => (
              <XStack
                key={comp.key || idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < components.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack width={6} height={6} borderRadius={1} backgroundColor={colors.figmaGreen} />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {comp.name}
                </Text>
                {comp.containing_frame?.name && (
                  <Text color={colors.muted} fontSize={9} numberOfLines={1}>
                    in {truncate(comp.containing_frame.name, 15)}
                  </Text>
                )}
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No components found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Component Sets ---

function GetComponentSetsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{
    meta?: { component_sets?: FigmaComponent[] };
    component_sets?: FigmaComponent[];
  }>(output);
  const componentSets = data?.meta?.component_sets || data?.component_sets || [];
  const count = componentSets.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} sets`, variant: 'purple' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'List component sets (variants)',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : componentSets.length > 0 ? (
            componentSets.slice(0, 10).map((set, idx) => (
              <XStack
                key={set.key || idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < componentSets.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={6}
                  height={6}
                  borderRadius={1}
                  backgroundColor={colors.figmaPurple}
                />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {set.name}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No component sets found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Export Images ---

function ExportImagesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ images?: Record<string, string>; err?: string }>(output);
  const nodeIds = (input?.nodeIds as string[]) || [];
  const format = input?.format || 'png';
  const imageCount = data?.images ? Object.keys(data.images).length : 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : imageCount > 0
        ? { text: `${imageCount} exported`, variant: 'blue' as const }
        : undefined;

  const displayError = error || data?.err || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: `Export as ${format.toUpperCase()}`,
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {/* Format info */}
          <XStack
            paddingVertical={6}
            paddingHorizontal={10}
            alignItems="center"
            gap={6}
            borderBottomWidth={1}
            borderBottomColor={colors.border}
          >
            <Text color={colors.muted} fontSize={9}>
              Format:
            </Text>
            <Badge text={format.toUpperCase()} variant="blue" />
            {input?.scale && (
              <>
                <Text color={colors.muted} fontSize={9}>
                  Scale:
                </Text>
                <Badge text={`${input.scale}x`} variant="gray" />
              </>
            )}
          </XStack>

          {status === 'failed' || displayError ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : data?.images ? (
            Object.entries(data.images)
              .slice(0, 5)
              .map(([nodeId, url], idx) => (
                <XStack
                  key={nodeId}
                  paddingVertical={5}
                  paddingHorizontal={10}
                  alignItems="center"
                  gap={8}
                  borderBottomWidth={idx < Object.keys(data.images!).length - 1 ? 1 : 0}
                  borderBottomColor={colors.border}
                >
                  <ImageIcon size={10} color={colors.figmaBlue} />
                  <Text
                    color={colors.secondary}
                    fontSize={9}
                    fontFamily="$mono"
                    flex={1}
                    numberOfLines={1}
                  >
                    {nodeId}
                  </Text>
                  <Badge text="ready" variant="green" />
                </XStack>
              ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                {nodeIds.length} nodes to export
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Comments ---

function GetCommentsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ comments?: FigmaComment[] }>(output);
  const comments = data?.comments || [];
  const count = comments.length;

  const unresolvedCount = comments.filter((c) => !c.resolved_at).length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} comments`, variant: 'yellow' as const }
        : { text: '0 comments', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'Get file comments',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : comments.length > 0 ? (
            comments.slice(0, 8).map((comment, idx) => (
              <XStack
                key={comment.id || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="flex-start"
                gap={8}
                borderBottomWidth={idx < comments.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={5}
                  height={5}
                  borderRadius={2.5}
                  backgroundColor={comment.resolved_at ? colors.muted : colors.badgeYellow.text}
                  marginTop={4}
                  flexShrink={0}
                />
                <YStack flex={1} gap={2}>
                  <XStack alignItems="center" gap={6}>
                    <Text color={colors.primary} fontSize={10} fontWeight="500">
                      {comment.user?.handle || 'Anonymous'}
                    </Text>
                    {comment.resolved_at && <Badge text="resolved" variant="gray" />}
                  </XStack>
                  <Text color={colors.secondary} fontSize={10} numberOfLines={2}>
                    {comment.message}
                  </Text>
                </YStack>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No comments found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Extract Colors ---

function ExtractColorsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ colors?: ColorValue[] | Record<string, string> }>(output);
  const format = input?.format || 'json';

  // Handle both array and object formats
  let colorList: { name: string; hex: string }[] = [];
  if (data?.colors) {
    if (Array.isArray(data.colors)) {
      colorList = data.colors.map((c, i) => ({ name: c.name || `color-${i}`, hex: c.hex }));
    } else {
      colorList = Object.entries(data.colors).map(([name, hex]) => ({ name, hex: String(hex) }));
    }
  }

  const count = colorList.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} colors`, variant: 'orange' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: `Extract colors (${format})`,
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : colorList.length > 0 ? (
            <XStack flexWrap="wrap" padding={8} gap={6}>
              {colorList.slice(0, 20).map((color, idx) => (
                <XStack
                  key={idx}
                  alignItems="center"
                  gap={6}
                  backgroundColor={colors.bgInnerDark}
                  paddingVertical={4}
                  paddingHorizontal={6}
                  borderRadius={4}
                >
                  <XStack
                    width={12}
                    height={12}
                    borderRadius={2}
                    backgroundColor={color.hex}
                    borderWidth={1}
                    borderColor="rgba(255,255,255,0.1)"
                  />
                  <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                    {color.hex}
                  </Text>
                </XStack>
              ))}
            </XStack>
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No colors found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Extract Typography ---

function ExtractTypographyRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ typography?: TypographyValue[] | Record<string, any> }>(output);
  const format = input?.format || 'json';

  // Handle both array and object formats
  let typeList: { name: string; font: string; size: number }[] = [];
  if (data?.typography) {
    if (Array.isArray(data.typography)) {
      typeList = data.typography.map((t, i) => ({
        name: `style-${i}`,
        font: t.fontFamily,
        size: t.fontSize,
      }));
    } else {
      typeList = Object.entries(data.typography).map(([name, val]: [string, any]) => ({
        name,
        font: val.fontFamily || val.font || 'Unknown',
        size: val.fontSize || val.size || 0,
      }));
    }
  }

  const count = typeList.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} styles`, variant: 'cyan' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: `Extract typography (${format})`,
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : typeList.length > 0 ? (
            typeList.slice(0, 10).map((style, idx) => (
              <XStack
                key={idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < typeList.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <Type size={10} color={colors.figmaBlue} />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {style.font}
                </Text>
                <Badge text={`${style.size}px`} variant="cyan" />
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No typography styles found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get File Styles ---

function GetFileStylesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ meta?: { styles?: FigmaStyle[] }; styles?: FigmaStyle[] }>(output);
  const styles = data?.meta?.styles || data?.styles || [];
  const count = styles.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} styles`, variant: 'purple' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'Get file styles',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : styles.length > 0 ? (
            styles.slice(0, 10).map((style, idx) => (
              <XStack
                key={style.key || idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < styles.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <XStack
                  width={6}
                  height={6}
                  borderRadius={1}
                  backgroundColor={
                    style.style_type === 'FILL'
                      ? colors.figmaOrange
                      : style.style_type === 'TEXT'
                        ? colors.figmaBlue
                        : style.style_type === 'EFFECT'
                          ? colors.figmaPurple
                          : colors.secondary
                  }
                />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {style.name}
                </Text>
                <Badge
                  text={style.style_type}
                  variant={
                    style.style_type === 'FILL'
                      ? 'orange'
                      : style.style_type === 'TEXT'
                        ? 'cyan'
                        : style.style_type === 'EFFECT'
                          ? 'purple'
                          : 'gray'
                  }
                />
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No styles found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get File Variables ---

function GetFileVariablesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{
    meta?: { variables?: Record<string, any>; variableCollections?: Record<string, any> };
  }>(output);
  const variables = data?.meta?.variables ? Object.keys(data.meta.variables).length : 0;
  const collections = data?.meta?.variableCollections
    ? Object.keys(data.meta.variableCollections).length
    : 0;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : variables > 0
        ? { text: `${variables} vars`, variant: 'green' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'Get file variables',
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
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {status === 'failed' ? (
            <Text color={colors.badgeRed.text} fontSize={10}>
              {displayError || 'Unknown error'}
            </Text>
          ) : (
            <>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={60}>
                  Variables
                </Text>
                <Text color={colors.bright} fontSize={10}>
                  {variables}
                </Text>
              </XStack>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={60}>
                  Collections
                </Text>
                <Text color={colors.bright} fontSize={10}>
                  {collections}
                </Text>
              </XStack>
            </>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Team Projects ---

function GetTeamProjectsRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ projects?: FigmaProject[] }>(output);
  const projects = data?.projects || [];
  const count = projects.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} projects`, variant: 'blue' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'List team projects',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : projects.length > 0 ? (
            projects.slice(0, 10).map((project, idx) => (
              <XStack
                key={project.id || idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < projects.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <FolderOpen size={10} color={colors.figmaBlue} />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {project.name}
                </Text>
                <Text color={colors.muted} fontSize={9} fontFamily="$mono">
                  {project.id}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No projects found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Get Project Files ---

function GetProjectFilesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<{ files?: FigmaProjectFile[] }>(output);
  const files = data?.files || [];
  const count = files.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} files`, variant: 'purple' as const }
        : { text: '0 found', variant: 'gray' as const };

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: 'List project files',
    duration,
    badge,
    expanded,
    onToggle,
    icon: <FigmaIconSimple />,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {status === 'failed' ? (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.badgeRed.text} fontSize={10}>
                {displayError || 'Unknown error'}
              </Text>
            </XStack>
          ) : files.length > 0 ? (
            files.slice(0, 10).map((file, idx) => (
              <XStack
                key={file.key || idx}
                paddingVertical={5}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < files.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <File size={10} color={colors.figmaPurple} />
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {file.name}
                </Text>
                <Text color={colors.muted} fontSize={9} fontFamily="$mono">
                  {file.key?.slice(0, 8)}...
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No files found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// --- Default Renderer ---

function DefaultFigmaRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : status === 'completed'
        ? { text: 'done', variant: 'green' as const }
        : undefined;

  const displayError = error || (status === 'failed' ? output : null);

  const headerProps = {
    status,
    description: shortName.replace(/figma-/g, '').replace(/-/g, ' '),
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
        <YStack
          backgroundColor={colors.bgInnerDark}
          borderRadius={6}
          padding={8}
          paddingHorizontal={10}
          gap={4}
        >
          {input &&
            Object.keys(input).length > 0 &&
            Object.entries(input)
              .slice(0, 5)
              .map(([key, value]) => (
                <XStack key={key} alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={50}>
                    {key}
                  </Text>
                  <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={1}>
                    {typeof value === 'string' ? truncate(value, 50) : JSON.stringify(value)}
                  </Text>
                </XStack>
              ))}

          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>
                result
              </Text>
              <Text color={colors.secondary} fontSize={9} flex={1} numberOfLines={2}>
                {truncate(output, 100)}
              </Text>
            </XStack>
          )}

          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={50}>
                error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}

          {!input && !output && !displayError && (
            <Text color={colors.muted} fontSize={10}>
              No details available
            </Text>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function FigmaRendererBase(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const shortName = getShortToolName(props.toolName);

  const subProps: SubRendererProps = {
    ...props,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  switch (shortName) {
    case 'figma-get-file':
      return <GetFileRenderer {...subProps} />;
    case 'figma-get-node':
      return <GetNodeRenderer {...subProps} />;
    case 'figma-get-components':
      return <GetComponentsRenderer {...subProps} />;
    case 'figma-get-component-sets':
      return <GetComponentSetsRenderer {...subProps} />;
    case 'figma-export-images':
      return <ExportImagesRenderer {...subProps} />;
    case 'figma-get-comments':
      return <GetCommentsRenderer {...subProps} />;
    case 'figma-extract-colors':
      return <ExtractColorsRenderer {...subProps} />;
    case 'figma-extract-typography':
      return <ExtractTypographyRenderer {...subProps} />;
    case 'figma-get-file-styles':
      return <GetFileStylesRenderer {...subProps} />;
    case 'figma-get-file-variables':
      return <GetFileVariablesRenderer {...subProps} />;
    case 'figma-get-team-projects':
      return <GetTeamProjectsRenderer {...subProps} />;
    case 'figma-get-project-files':
      return <GetProjectFilesRenderer {...subProps} />;
    default:
      return <DefaultFigmaRenderer {...subProps} />;
  }
}

export const FigmaToolCallRenderer = withPermissionSupport(FigmaRendererBase);

// Default export for dynamic import
export default FigmaToolCallRenderer;
