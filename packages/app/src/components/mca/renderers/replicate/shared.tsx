/**
 * Replicate Renderer — shared helpers (post Follow-up E migration POC).
 *
 * TER-281 zero-component rule: this file exposes ZERO local UI components
 * for Replicate. Sub-renderers compose the global primitives directly:
 *   <ToolCallCard>, <Badge>, <ErrorBlock>, etc. from `mca/primitives`.
 *
 * What lives here:
 *   - Replicate-specific data helpers (extractMediaUrls, isImageTool, …).
 *   - The Replicate icon URL constant for `<ToolCallCard iconUri>`.
 *   - A `replicateBadgeProps()` helper that maps Replicate's exotic
 *     variants ('white', 'purple') to the v2 set ('gray', 'info'), so
 *     sub-renderers stay one-line: `<Badge {...replicateBadgeProps(t,v)}/>`.
 *   - `LoadingPlaceholder` is the only Replicate-specific component left
 *     — it shows an "image/video skeleton" with vendor copy. If a future
 *     MCA needs a similar idle state, promote it to `primitives/Empty`
 *     with a `kind` variant.
 */

import { Image as ImageIcon, Video } from '../../primitives';
import Svg, { Path } from 'react-native-svg';
import { Text, YStack } from 'tamagui';
import { type BadgeVariant, colors } from '../../primitives';
import { useColors } from '../../primitives';

// ─── Identity ──────────────────────────────────────────────────────────────

/**
 * Backend-served Replicate icon. Kept as a constant so sub-renderers
 * pass it as `<ToolCallCard iconUri={REPLICATE_ICON}>` without each
 * file knowing about the path scheme. NOTE: when EXPO_PUBLIC_BACKEND_URL
 * is set, the icon resolves via the backend static path; otherwise we
 * fall back to the inline SVG (`<ReplicateLogo>`) for chat bubbles.
 */
export const REPLICATE_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ''}/static/mcas/mca.replicate/icon.png`;

/** Inline Replicate wordmark — used when iconUri is unavailable. */
export function ReplicateLogo({ size = 14 }: { size?: number }) {
  const c = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z"
        fill={c.text2}
      />
    </Svg>
  );
}

// ─── Data helpers ──────────────────────────────────────────────────────────

/**
 * Extract short tool name from full tool name.
 * "replicate_replicate-flux-pro" -> "replicate-flux-pro"
 */
export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T = unknown>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return { text: output } as T;
  }
}

export function truncate(text: string, maxLength = 50): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

/** "black-forest-labs/flux-pro" -> "flux-pro" */
export function getModelDisplayName(model: string): string {
  if (!model) return 'Unknown';
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

export function isImageTool(toolName: string): boolean {
  const short = getShortToolName(toolName);
  return short.includes('flux') || short === 'replicate-run';
}

export function isVideoTool(toolName: string): boolean {
  const short = getShortToolName(toolName);
  return short.includes('video') || short.includes('minimax') || short.includes('veo');
}

/** Extract image/video URLs from output (handles 4 known shapes). */
export function extractMediaUrls(output: unknown): string[] {
  if (!output) return [];

  if (Array.isArray(output)) {
    return output.filter((item): item is string => typeof item === 'string' && item.startsWith('http'));
  }

  if (typeof output === 'object' && output !== null) {
    const o = output as Record<string, unknown>;
    if (Array.isArray(o.output)) {
      return o.output.filter((item): item is string => typeof item === 'string' && item.startsWith('http'));
    }
    if (typeof o.output === 'string' && o.output.startsWith('http')) {
      return [o.output];
    }
    if (typeof o.url === 'string') {
      return [o.url];
    }
  }

  if (typeof output === 'string' && output.startsWith('http')) {
    return [output];
  }

  return [];
}

// ─── Badge variant mapping ─────────────────────────────────────────────────

/**
 * Replicate's pre-v2 renderer used a custom set of Badge variants
 * (`white`, `purple`) that don't exist in the global `BadgeVariant`.
 * This helper maps them to the v2 set, keeping sub-renderers terse:
 *
 *   <Badge {...replicateBadgeProps('flux-pro', 'white')} />
 *
 * Visual mapping (closest semantic match):
 *   - white  → gray   (model name chip, neutral)
 *   - blue   → info   (info chip)
 *   - purple → info   (count chip — was indigo in pre-v2, info maps cleanly)
 *   - red    → error
 *   - success / gray → identity
 */
export type ReplicateBadgeVariant = 'success' | 'white' | 'blue' | 'purple' | 'red' | 'gray';

export function replicateBadgeProps(
  text: string,
  variant: ReplicateBadgeVariant,
): { text: string; variant: BadgeVariant } {
  const mapped: BadgeVariant =
    variant === 'red' ? 'error'
    : variant === 'blue' ? 'info'
    : variant === 'purple' ? 'info'
    : variant === 'white' ? 'gray'
    : variant; // 'success' | 'gray' identity
  return { text, variant: mapped };
}

// ─── Replicate-specific UI fragment (kept) ─────────────────────────────────

/**
 * Replicate-specific idle state. Shows a vendor-flavored skeleton with
 * the right copy ("Generating image…" / "Generating video…"). Other
 * MCAs that need a similar state should compose `<Empty>` from primitives
 * — promoting this to a primitive has been deferred (no second consumer).
 */
export function LoadingPlaceholder({ icon }: { icon?: 'image' | 'video' }) {
  const c = useColors();
  const Icon = icon === 'video' ? Video : ImageIcon;
  const text = icon === 'video' ? 'Generating video...' : 'Generating image...';

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      padding={10}
      alignItems="center"
      gap={8}
    >
      <Icon size={24} color={c.text3} />
      <Text color={c.text2} fontSize={10}>
        {text}
      </Text>
    </YStack>
  );
}
