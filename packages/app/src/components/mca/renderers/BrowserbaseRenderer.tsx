/**
 * Browserbase MCA — Custom Tool Call Renderer
 *
 * Renders tool calls from mca.browserbase with context-aware UI:
 * - session-create: shows session ID + "Open Live View" button
 * - navigate: shows URL being visited
 * - snapshot/get-content: shows page info
 * - All others: compact status row
 */

import {
  ChevronRight,
  ExternalLink,
  Globe,
  MonitorPlay,
  Navigation,
  ScanText,
  MousePointer,
  Keyboard,
  Code,
  Camera,
  Wifi,
  X,
  List,
} from '../primitives';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useTilingStore } from '../../../store/tilingStore';
import { Badge, colors, ErrorBlock, useColors } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// ============================================================================
// Colors — Renderer UX Guide v2 §5.
// ============================================================================
// Theme-adaptive palette: brand hex are semantic (theme-agnostic, identical
// in light + dark), surface tokens (bg, text, border, chevron) come from
// `useColors()` and switch on theme. The hook returns the same shape as
// the old module-level `C` so the rest of the file barely changes.

function useC() {
  const c = useColors();
  return {
    brand: colors.indigo,
    brandBg: 'rgba(94,106,210,0.12)',
    brandBorder: 'rgba(94,106,210,0.25)',
    brandText: c.badges.info.text,

    success: colors.green,
    running: colors.indigo,
    failed: colors.red,

    glowSuccess: 'rgba(34,197,94,0.5)',
    glowRunning: 'rgba(94,106,210,0.6)',
    glowFailed: 'rgba(239,68,68,0.5)',

    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    bgCard: c.bgCard,
    bgCardHover: c.bgCardHover,
    bgInner: c.bgInner,
    border: c.border,
    chevron: c.text3,
  };
}

// ============================================================================
// Tool metadata
// ============================================================================

interface ToolMeta {
  Icon: typeof Globe;
  label: string;
}

/**
 * Renderer UX Guide v2 §7 DON'T: never derive behavior from
 * `toolName.includes(...)`. Use an explicit map keyed by the short
 * tool name (the segment after the appInstance prefix).
 */
const TOOL_META: Record<string, ToolMeta> = {
  'session-create':  { Icon: MonitorPlay, label: 'Create session' },
  'session-list':    { Icon: List,        label: 'List sessions' },
  'session-close':   { Icon: X,           label: 'Close session' },
  'navigate':        { Icon: Globe,       label: 'Navigate' },
  'navigate-back':   { Icon: Navigation,  label: 'Navigate back' },
  'snapshot':        { Icon: ScanText,    label: 'Snapshot' },
  'get-content':     { Icon: ScanText,    label: 'Get content' },
  'click':           { Icon: MousePointer, label: 'Click' },
  'type':            { Icon: Keyboard,    label: 'Type' },
  'fill-form':       { Icon: Keyboard,    label: 'Fill form' },
  'evaluate':        { Icon: Code,        label: 'Evaluate JS' },
  'press-key':       { Icon: Keyboard,    label: 'Press key' },
  'wait-for':        { Icon: Globe,       label: 'Wait' },
  'take-screenshot': { Icon: Camera,      label: 'Screenshot' },
  'network':         { Icon: Wifi,        label: 'Network requests' },
};

function getToolMeta(toolName: string): ToolMeta {
  const short = toolName.replace(/^[^_]+_/, ''); // strip app prefix
  return TOOL_META[short] ?? { Icon: Globe, label: 'Browserbase' };
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Sub-components
// ============================================================================

function StatusDot({ status }: { status: 'running' | 'completed' | 'failed' | 'pending' | 'pending_permission' }) {
  const C = useC();
  const color = status === 'running' ? C.running : status === 'completed' ? C.success : C.failed;
  const glow  = status === 'running' ? C.glowRunning : status === 'completed' ? C.glowSuccess : C.glowFailed;
  const pulse = usePulseAnimation(status === 'running' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6, height: 6, borderRadius: 3,
        backgroundColor: color, flexShrink: 0,
        opacity: status === 'running' || status === 'pending_permission' ? pulse : 1,
        shadowColor: glow, shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1, shadowRadius: 3, elevation: 3,
      }}
    />
  );
}

// ============================================================================
// Session create — special card with Live View button
// ============================================================================

function SessionCreateCard({
  status, input, output, error, duration,
}: Pick<ToolCallRendererProps, 'status' | 'input' | 'output' | 'error' | 'duration'>) {
  const C = useC();
  const openWindow = useTilingStore((s) => s.openWindow);
  const [expanded, setExpanded] = useState(false);

  // Parse sessionId and liveViewUrl from output
  let sessionId: string | null = null;
  let liveViewUrl: string | null = null;

  if (status === 'completed' && output) {
    try {
      const parsed = JSON.parse(output);
      sessionId  = parsed.sessionId  ?? null;
      liveViewUrl = parsed.liveViewUrl ?? null;
    } catch {}
  }

  const shortId = sessionId ? sessionId.slice(0, 8) : null;

  const handleOpenLiveView = () => {
    if (!sessionId || !liveViewUrl) return;
    openWindow('browserbase-live-view', { sessionId, liveViewUrl }, true);
  };

  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150, easing: Easing.inOut(Easing.ease), useNativeDriver: true,
    }).start();
  }, [expanded]);
  const rotation = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });

  return (
    <YStack width="100%" gap={4}>
      {/* Dropdown card */}
      <YStack
        backgroundColor={C.bgCard}
        borderRadius={8}
        borderWidth={1}
        borderColor={C.border}
        overflow="hidden"
        width="100%"
      >
        {/* Header row */}
        <XStack
          alignItems="center"
          gap={8}
          paddingVertical={6}
          paddingHorizontal={10}
          borderBottomWidth={expanded ? 1 : 0}
          borderBottomColor={C.border}
          onPress={() => setExpanded(!expanded)}
          cursor="pointer"
          pressStyle={{ backgroundColor: C.bgInner }}
          hoverStyle={{ backgroundColor: C.bgCardHover }}
        >
          <StatusDot status={status === 'pending' ? 'running' : status as any} />
          <MonitorPlay size={12} color={C.brand} />

          <Text flex={1} color={C.primary} fontSize={11} fontWeight="500" numberOfLines={1} ellipsizeMode="tail">
            {status === 'running' ? 'Creating session…' : shortId ? `Session ${shortId}…` : 'Create session'}
          </Text>

          {status === 'running' && (
            <Text color={C.running} fontSize={9} fontFamily="$mono">starting</Text>
          )}
          {status === 'completed' && shortId && (
            <Badge text="active" variant="success" />
          )}
          {status === 'failed' && (
            <Badge text="failed" variant="error" />
          )}

          <Animated.View style={{ transform: [{ rotate: rotation }] }}>
            <ChevronRight size={10} color={C.chevron} />
          </Animated.View>
        </XStack>

        {/* Expanded body — only session ID, no Live View button here */}
        {expanded && (
          <YStack padding={8} gap={6}>
            {sessionId && (
              <XStack
                backgroundColor={C.bgInner}
                borderRadius={5}
                paddingVertical={6}
                paddingHorizontal={8}
                gap={8}
                alignItems="center"
              >
                <Text color={C.muted} fontSize={9} width={50}>Session</Text>
                <Text color={C.secondary} fontSize={10} fontFamily="$mono" flex={1} numberOfLines={1}>
                  {sessionId}
                </Text>
              </XStack>
            )}
            {error && <ErrorBlock error={error} />}
          </YStack>
        )}
      </YStack>

      {/* Live View button — outside the dropdown, only when session is active */}
      {status === 'completed' && liveViewUrl && (
        <XStack
          backgroundColor={C.brandBg}
          borderRadius={6}
          borderWidth={1}
          borderColor={C.brandBorder}
          paddingVertical={7}
          paddingHorizontal={10}
          alignItems="center"
          gap={8}
          onPress={handleOpenLiveView}
          cursor="pointer"
          pressStyle={{ opacity: 0.75 }}
          hoverStyle={{ backgroundColor: 'rgba(99,102,241,0.2)' }}
        >
          <ExternalLink size={12} color={C.brand} />
          <Text color={C.brandText} fontSize={11} fontWeight="600" flex={1}>
            Open Live View
          </Text>
          <XStack alignItems="center" gap={4}>
            <YStack width={6} height={6} borderRadius={3} backgroundColor={C.success} />
            <Text color={C.success} fontSize={9} fontWeight="700">LIVE</Text>
          </XStack>
        </XStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Generic compact renderer
// ============================================================================

function GenericRow({
  toolName, status, input, output, error, duration,
}: ToolCallRendererProps) {
  const C = useC();
  const [expanded, setExpanded] = useState(false);
  const { Icon, label } = getToolMeta(toolName);

  // Build description from input. Dispatch by short tool name (guide §7 DON'T:
  // never .includes() on toolName). Each branch enriches the static `label`
  // with the most informative input param when present.
  const short = toolName.replace(/^[^_]+_/, '');
  let description = label;
  if (short === 'navigate' && input?.url) {
    description = `Navigate → ${input.url}`;
  } else if (short === 'click' && input?.element) {
    description = `Click "${input.element}"`;
  } else if (short === 'type' && input?.element) {
    description = `Type into "${input.element}"`;
  } else if (short === 'session-close' && input?.sessionId) {
    description = `Close ${(input.sessionId as string).slice(0, 8)}…`;
  }

  const hasDetails = !!(output || error);

  const rotateAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150, easing: Easing.inOut(Easing.ease), useNativeDriver: true,
    }).start();
  }, [expanded]);
  const rotation = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });

  const header = (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={expanded ? 'transparent' : C.bgCard}
      borderRadius={expanded ? 0 : 8}
      borderWidth={expanded ? 0 : 1}
      borderColor={expanded ? 'transparent' : C.border}
      borderBottomWidth={1}
      borderBottomColor={C.border}
      onPress={() => hasDetails && setExpanded(!expanded)}
      cursor={hasDetails ? 'pointer' : 'default'}
      pressStyle={hasDetails ? { backgroundColor: C.bgInner } : {}}
      hoverStyle={hasDetails ? { backgroundColor: C.bgCardHover } : {}}
    >
      <StatusDot status={status === 'pending' ? 'running' : status as any} />
      <Icon size={12} color={C.brand} />
      <Text flex={1} color={C.primary} fontSize={11} fontWeight="500" numberOfLines={1} ellipsizeMode="tail">
        {description}
      </Text>
      {status === 'running' && (
        <Text color={C.running} fontSize={9} fontFamily="$mono">running</Text>
      )}
      {hasDetails && (
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={10} color={C.chevron} />
        </Animated.View>
      )}
    </XStack>
  );

  if (!expanded) return header;

  return (
    <YStack backgroundColor={C.bgCard} borderRadius={8} borderWidth={1} borderColor={C.border} overflow="hidden" width="100%">
      {header}
      <YStack padding={8} gap={6}>
        {output && (
          <YStack backgroundColor={C.bgInner} borderRadius={5} padding={8}>
            <Text color={C.secondary} fontSize={10} fontFamily="$mono" numberOfLines={8}>
              {output.slice(0, 600)}{output.length > 600 ? '…' : ''}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </YStack>
    </YStack>
  );
}

// ============================================================================
// Main renderer
// ============================================================================

function BrowserbaseRendererBase(props: ToolCallRendererProps) {
  const n = props.toolName.replace(/^[^_]+_/, '');

  if (n === 'session-create') {
    return (
      <SessionCreateCard
        status={props.status}
        input={props.input}
        output={props.output}
        error={props.error}
      />
    );
  }

  return <GenericRow {...props} />;
}

export const BrowserbaseToolCallRenderer = withPermissionSupport(BrowserbaseRendererBase);
export default BrowserbaseToolCallRenderer;
