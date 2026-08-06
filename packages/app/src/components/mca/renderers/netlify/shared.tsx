/**
 * Shared utilities for the Netlify renderer.
 *
 * Renderer UX Guide v2/v2.1 — brand identity comes from three mechanisms, NOT
 * from duplicating global primitives:
 *  - the official Netlify logo via `iconUri` (the registered app icon)
 *  - the official Netlify palette below (real vendor hex, not Tailwind defaults)
 *  - the deploy `state` from the backend, mapped to a semantic color
 *
 * This file exports only the palette hook + pure helpers + one compose-only
 * `UrlLink` helper (composes Text + Linking; there is no global URL-link
 * primitive to reuse). No global primitive is re-implemented here.
 */

import type React from 'react';
import { Linking } from 'react-native';
import { Text, XStack } from 'tamagui';
import { colors, ExternalLink, useColors, useMcaTheme } from '../../primitives';

// ============================================================================
// Palette — official Netlify brand (theme-agnostic) + theme-adaptive tokens
//
// Combines the official Netlify brand colors (kept hardcoded per brand
// guidelines) with the Design System theme-adaptive surface tokens from
// `useColors()`. The web scrollbar color switches between dark and light
// variants so it remains visible on both card backgrounds.
// ============================================================================

/** Netlify primary teal (https://www.netlify.com brand). */
export const NETLIFY_TEAL = '#00C7B7';

export function useNetlifyColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Expose the full v2 adaptive surface set (bgPage, bgCard, text, text2,
    // text3, border, borderStrong, shadow, …) plus badges.
    ...c,

    theme,
    isDark,

    // Netlify brand (theme-agnostic vendor identity)
    teal: NETLIFY_TEAL,
    tealDark: '#00AD9F',

    // Deploy state (semantic, theme-agnostic) — reuse the shared green/red
    // tokens so success/error never drift from the rest of the renderer system.
    stateReady: colors.green,
    stateBuilding: NETLIFY_TEAL,
    stateError: colors.red,

    // Badges (theme-adaptive) — kept under the legacy `badge*` aliases so the
    // 4 consumer renderers keep working without touching their call sites.
    badgeOk: c.badges.ok,
    badgeErr: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarn: c.badges.warn,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive) — legacy aliases for the v2 `text`/`text2`/`text3`
    // surface tokens, kept so consumers don't need to change.
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Scrollbar thumb must invert between themes to stay visible against the
    // card surface (same pattern as linear/canva renderers).
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
  };
}

// ============================================================================
// Pure helpers
// ============================================================================

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Strip the scheme so a deploy URL reads as a clean host (`my-site.netlify.app`). */
export function prettyHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const READY_STATES = new Set(['ready']);
const FAILED_STATES = new Set(['error', 'rejected']);

export type StateVariant = 'success' | 'error' | 'info' | 'gray';

/** Map a Netlify deploy state to a Badge variant. */
export function deployStateVariant(state?: string): StateVariant {
  if (!state) return 'gray';
  if (READY_STATES.has(state)) return 'success';
  if (FAILED_STATES.has(state)) return 'error';
  return 'info';
}

/** Map a Netlify deploy state to a semantic dot color (theme-agnostic). */
export function deployStateColor(
  state: string | undefined,
  colors: ReturnType<typeof useNetlifyColors>,
): string {
  const c = useNetlifyColors();
  if (!state) return c.text3;
  if (READY_STATES.has(state)) return colors.stateReady;
  if (FAILED_STATES.has(state)) return colors.stateError;
  return colors.stateBuilding;
}

// ============================================================================
// UrlLink — compose-only clickable URL (Text + Linking). Not a global primitive.
//
// TER-281 note: this is deliberately kept LOCAL for now. It composes existing
// primitives (Text + ExternalLink + Linking) rather than re-implementing one,
// and there is no global URL-link primitive to reuse yet. If a second MCA needs
// a clickable URL, promote this to `primitives/UrlLink.tsx` in that MCA's branch
// (additive) and migrate both call sites — don't fork a copy.
// ============================================================================

export function UrlLink({
  url,
  label,
  size = 11,
  bold = false,
}: {
  url: string;
  label?: string;
  size?: number;
  bold?: boolean;
}): React.ReactElement {
  return (
    <XStack
      alignItems="center"
      gap={4}
      onPress={() => {
        void Linking.openURL(url);
      }}
      hoverStyle={{ opacity: 0.8 }}
      cursor="pointer"
    >
      <ExternalLink size={size} color={NETLIFY_TEAL} />
      <Text
        color={NETLIFY_TEAL}
        fontSize={size}
        fontFamily="$mono"
        fontWeight={bold ? '600' : '400'}
        numberOfLines={1}
        textDecorationLine="underline"
      >
        {label ?? prettyHost(url)}
      </Text>
    </XStack>
  );
}
