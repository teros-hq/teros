import type React from 'react';
import { useEffect, useState } from 'react';
import { AnimatePresence, YStack } from 'tamagui';
import type { McaStatusType } from './colors';
import { ExpandedBody, ExpandedContainer } from './Containers';
import { HeaderRow } from './HeaderRow';
import { usePermissionControls } from './PermissionControlsContext';
import { inferTenseForms, tenseByStatus } from './tense';

interface ToolCallCardProps {
  status: McaStatusType;
  /**
   * Fully-composed description string. Pass this when the renderer already
   * knows the exact text it wants to show (e.g. `"Events (March 5, Berlin)"`,
   * `"Items in folder /"`). Takes precedence over `verb` when both are set.
   *
   * For the default tool-call case ("List files" / "Search messages"), prefer
   * `verb` so the primitive applies the §2.3 tense automatically and renderers
   * don't have to remember to import helpers.
   */
  description?: string;
  /**
   * Imperative verb phrase (e.g. `"List files"`, `"Send email"`). The card
   * composes the §2.3 tense (`Will…` / `Listing…` / `Listed…` / `Failed to…` /
   * `Wants to…`) automatically from `status`. This is the canonical way to
   * pass a description — single source of truth, no per-renderer wiring.
   *
   * Either `description` or `verb` MUST be provided. If both are set,
   * `description` wins (back-compat for renderers that compose contextual
   * descriptions themselves).
   */
  verb?: string;
  /**
   * @deprecated Renderer UX Guide v2 §7 forbids showing tool execution
   *   duration in the header. The prop is kept for backwards compatibility
   *   so the 70+ existing renderers keep compiling, but the value is
   *   silently ignored — nothing is rendered. Remove this prop from new
   *   code. The migration sweep (Fase 5) drops it from all callers.
   */
  duration?: number;
  iconUri?: string;
  badge?: React.ReactNode;
  isInContainer?: boolean;
  defaultExpanded?: boolean;
  /**
   * Optional left-edge accent color. When set, paints a 3px borderLeft on
   * the card. Use sparingly — only when the accent encodes information
   * not already conveyed by the StatusDot or Badge (regla
   * `feedback_color_signal_over_noise`).
   */
  accent?: string;
  /**
   * If true, expansion/collapse fades in/out via CSS transition
   * (`@tamagui/animations-css` driver, preset `card` = 240ms cubic-bezier
   * with soft overshoot). Default `false` keeps legacy instant-toggle
   * for any consumer that doesn't opt in.
   */
  animateExpand?: boolean;
  /**
   * Binary marker for irreversible operations (Renderer UX Guide v2 §8).
   * Renders an irreversibility indicator in the header. Sourced from
   * `manifest.tools[name].annotations.irreversible` upstream.
   */
  irreversible?: boolean;
  /**
   * Binary marker for elevated security/blast risk (Renderer UX Guide
   * v2.1 §8.5). Renders the Risk Indicator amber badge in the header.
   * Decided per-call by `isToolCallElevatedRisk(mcaId, toolName, input)`
   * — see `permission-heuristics.ts`.
   */
  risk?: boolean;
  children?: React.ReactNode;
}

export function ToolCallCard({
  status,
  description,
  verb,
  duration: _duration, // accepted for back-compat, intentionally unused (guide v2 §7)
  iconUri,
  badge,
  isInContainer,
  defaultExpanded = false,
  accent,
  animateExpand = false,
  irreversible,
  risk,
  children,
}: ToolCallCardProps) {
  // Description resolution (Renderer UX Guide v2 §2.3):
  //   1. If `description` is set, the renderer owns the text fully (e.g. it
  //      already composed `"Events (March 5)"`). Pass through verbatim.
  //   2. Else if `verb` is set, compose tense automatically from status —
  //      this is the canonical path for the default tool-call case and the
  //      single source of truth for the §2.3 verb-tense rules.
  //   3. Else fall back to an empty string. Either prop should be set in
  //      practice; the fallback exists only so a missing prop doesn't crash.
  const resolvedDescription =
    description ?? (verb ? tenseByStatus(status, inferTenseForms(verb)) : '');
  // When a permission request is active, the surrounding HOC injects the
  // permission context. The card automatically expands and appends the
  // ControlsBar at the end of the body — renderers stay ignorant of the
  // flow (Renderer UX Guide v2 §8).
  const permission = usePermissionControls();
  const [expanded, setExpanded] = useState(defaultExpanded || Boolean(permission?.forceExpand));

  // Keep the card open while a permission request is pending. Closing it
  // would hide the ControlsBar that the user must act on.
  useEffect(() => {
    if (permission?.forceExpand) setExpanded(true);
  }, [permission?.forceExpand]);

  const header = (
    <HeaderRow
      status={status}
      description={resolvedDescription}
      iconUri={iconUri}
      badge={badge}
      irreversible={irreversible}
      risk={risk}
      expanded={expanded}
      onToggle={() => setExpanded((prev) => !prev)}
      isInContainer={isInContainer}
    />
  );

  // The Allow/Deny ControlsBar is rendered by `withPermissionSupport` AFTER
  // the card — the permission gate is owned by the HOC so it works for every
  // renderer regardless of composition (ToolCallCard vs HeaderRow/Expanded…).
  // ToolCallCard only consumes `permission` for `forceExpand` (keep the card
  // open while a request is pending). See withPermissionSupport.tsx.
  const bodyContent = children ?? null;

  if (!bodyContent) return header;

  const accentBorder = accent
    ? { borderLeftWidth: 3, borderLeftColor: accent }
    : null;

  // We animate `opacity` + `scale` (transform, NOT layout). Scale gives
  // a tactile "pop" without causing the text below to shift, because
  // transforms don't affect document flow. translateY is intentionally
  // avoided — that *would* shift surrounding text during the transition.
  const animatedBody = (
    <YStack
      key="tool-call-body"
      animation="card"
      opacity={1}
      scale={1}
      enterStyle={{ opacity: 0, scale: 0.96 }}
      exitStyle={{ opacity: 0, scale: 0.98 }}
      transformOrigin="top"
    >
      <ExpandedBody>{bodyContent}</ExpandedBody>
    </YStack>
  );

  const renderBody = () => {
    if (!expanded) return null;
    if (animateExpand) return animatedBody;
    return <ExpandedBody>{bodyContent}</ExpandedBody>;
  };

  return (
    <YStack width="100%" {...(accentBorder ?? {})}>
      {isInContainer ? (
        <>
          {header}
          {animateExpand ? <AnimatePresence>{renderBody()}</AnimatePresence> : renderBody()}
        </>
      ) : (
        <ExpandedContainer>
          {header}
          {animateExpand ? <AnimatePresence>{renderBody()}</AnimatePresence> : renderBody()}
        </ExpandedContainer>
      )}
    </YStack>
  );
}
