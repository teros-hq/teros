import { ChevronRight, ShieldAlert } from './icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { Image, Text, View as TView, XStack } from 'tamagui';
import { indicators, type McaStatusType } from './colors';
import { StatusDot } from './StatusDot';
import { MCA_STRINGS } from './strings';
import { useColors } from './useColors';

export interface HeaderRowProps {
  status: McaStatusType;
  description: string;
  iconUri?: string;
  badge?: React.ReactNode;
  /**
   * Binary marker (Renderer UX Guide v2 §8). When `true`, the irreversibility
   * indicator is rendered in the header just before the chevron. No risk
   * levels, no gradations — either present or absent.
   */
  irreversible?: boolean;
  /**
   * Binary marker (Renderer UX Guide v2.1 §8.5). When `true`, the Risk
   * Indicator amber badge is rendered between the badge and the
   * Irreversibility marker. Same binary rule as §8 — no gradations,
   * the literal text is just "risk". Activates for security-elevated
   * or blast-radius idioms even when the action is technically
   * reversible (chmod 777, sudo, curl|sh, kubectl --all, etc.).
   */
  risk?: boolean;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
  /**
   * @deprecated Renderer UX Guide v2 §7 forbids duration in the header.
   *   Accepted only as a backwards-compat shim while consumers migrate to
   *   the new ToolCallCard contract. The value is silently ignored —
   *   nothing is rendered. Migration sweep in Fase 5 removes the prop
   *   from every caller.
   */
  duration?: number;
  /**
   * @deprecated Same rationale as `duration` — extension props from older
   *   bespoke headers (Bash exit code, etc.) survived as a backwards-
   *   compat shim. The value is silently ignored. Bash-style metadata
   *   should now live in the body (Fase 3 Fallback Body / custom renderer).
   */
  exitCode?: number;
}

// Header anatomy — exactly 5 slots, immutable order (guide §2):
//
//   [1] StatusDot   — auto by status
//   [2] App icon    — 14x14 from iconUri, neutral placeholder if absent
//   [3] Description — flex:1, single-line, ellipsis on overflow
//   [4] Badge       — optional, max 1 contextual signal
//   [5] Chevron     — animated 0→90deg
//
// Optionally an Irreversibility marker may appear between badge and chevron.
//
// Notes:
// • No duration is rendered (guide §7 DON'T list).
// • No "running"/"awaiting" auxiliary text — the StatusDot encodes state.
// • Header never wraps to two lines.
export function HeaderRow({
  status,
  description,
  iconUri,
  badge,
  irreversible,
  risk,
  expanded,
  onToggle,
  isInContainer,
  duration: _duration, // back-compat shim, intentionally unused (guide v2 §7)
  exitCode: _exitCode, // back-compat shim, intentionally unused
}: HeaderRowProps) {
  const c = useColors();
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  // On web, the RN Animated `transform: [{ rotate }]` interpolation doesn't
  // produce a CSS transform that re-renders smoothly — Tamagui re-renders
  // wipe it. We use a plain CSS transition on `transform` instead; the
  // value (90deg / 0deg) is recomputed each render and the browser animates
  // between them. On native, the Animated.Value path stays intact.
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
      backgroundColor={isInContainer ? 'transparent' : c.bgCard}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : c.border}
      borderBottomWidth={1}
      borderBottomColor={c.border}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: c.bgCardHover,
      }}
      hoverStyle={{
        backgroundColor: c.bgCardHover,
        borderColor: isInContainer ? 'transparent' : c.borderStrong,
      }}
      onPress={onToggle}
      cursor="pointer"
      // Guide §1: tap the header to toggle. Announce as a button to
      // screen readers with the current expansion state so VoiceOver/
      // TalkBack speak "Tool call header, button, expanded/collapsed".
      // Tamagui XStack on web doesn't propagate `accessibilityState`
      // → `aria-expanded`, so we set it explicitly as an HTML attribute.
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      {...(Platform.OS === 'web' ? { 'aria-expanded': expanded } : {})}
    >
      {/* [1] StatusDot */}
      <StatusDot status={status} />

      {/* [2] App icon — 14x14, neutral placeholder when no iconUri */}
      {iconUri ? (
        <Image source={{ uri: iconUri }} width={14} height={14} borderRadius={2} />
      ) : (
        <XStack
          width={14}
          height={14}
          borderRadius={2}
          borderWidth={1}
          borderStyle="dashed"
          borderColor={c.borderStrong}
          flexShrink={0}
        />
      )}

      {/* [3] Description — flex, single-line, ellipsis */}
      <Text
        flex={1}
        color={c.text}
        fontSize={11}
        fontWeight="500"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {description}
      </Text>

      {/* [4] Badge — optional, max 1 contextual signal */}
      {badge}

      {/* Risk Indicator — binary, between badge and irreversibility marker.
          Amber palette (vs irreversible's red) to communicate the
          orthogonal axis. The literal "risk" text — no gradations per
          guide v2.1 §8.5. */}
      {risk && (
        <XStack
          accessible
          accessibilityRole="alert"
          accessibilityLabel={MCA_STRINGS.permission.riskAriaLabel}
          alignItems="center"
          gap={3}
          paddingHorizontal={6}
          paddingVertical={1}
          borderRadius={4}
          backgroundColor={indicators.risk.bg}
          borderWidth={1}
          borderColor={indicators.risk.border}
          flexShrink={0}
        >
          <ShieldAlert size={9} color={indicators.risk.fg} />
          <Text color={indicators.risk.fg} fontSize={9} fontFamily="$mono" letterSpacing={0.4}>
            {MCA_STRINGS.permission.risk}
          </Text>
        </XStack>
      )}

      {/* Irreversibility marker — binary, between badge and chevron.
          a11y: announced as "alert" so screen readers raise the
          warning ahead of the trailing chevron. The icon is hidden
          (decorative); the text + accessibilityLabel carry meaning.
          For deuteranopia, the literal "irreversible" word is the
          primary signal — colour alone wouldn't suffice. */}
      {irreversible && (
        <XStack
          accessible
          accessibilityRole="alert"
          accessibilityLabel={MCA_STRINGS.permission.irreversibleAriaLabel}
          alignItems="center"
          gap={3}
          paddingHorizontal={6}
          paddingVertical={1}
          borderRadius={4}
          backgroundColor={indicators.irreversible.bg}
          borderWidth={1}
          borderColor={indicators.irreversible.border}
          flexShrink={0}
        >
          <ShieldAlert size={9} color={indicators.irreversible.fg} />
          <Text
            color={indicators.irreversible.fg}
            fontSize={9}
            fontFamily="$mono"
            letterSpacing={0.4}
          >
            {MCA_STRINGS.permission.irreversible}
          </Text>
        </XStack>
      )}

      {/* [5] Chevron — animated 0→90deg.
          Web path: plain transform string + CSS transition (RN Animated
          `[{rotate}]` doesn't survive Tamagui re-renders in web). Native
          path: the original Animated.View. */}
      {Platform.OS === 'web' ? (
        <TView
          // `transition` is a web-only CSS property (no RN ViewStyle key).
          // The cast must stay opaque (`as object`) — narrowing it to
          // `React.CSSProperties` contaminates the type inference when
          // Tamagui composes the style and breaks neighbouring RN keys.
          style={
            {
              transform: `rotate(${expanded ? 90 : 0}deg)`,
              transition: 'transform 150ms ease-in-out',
            } as object
          }
        >
          <ChevronRight size={10} color={c.text3} />
        </TView>
      ) : (
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={10} color={c.text3} />
        </Animated.View>
      )}
    </XStack>
  );
}
