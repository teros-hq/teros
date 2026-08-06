/**
 * mca.hunter — Tool Call Renderer
 *
 * Cobertura 100%: cada tool del MCA Hunter tiene un sub-renderer dedicado que
 * compone primitivos globales (patrón TER-281). El `FallbackRenderer` es
 * dev-only — su aparición señala un bug (tool sin sub-renderer).
 *
 * Tools cubiertas:
 *   - domain-search   → lista de emails con confidence badge
 *   - email-finder    → email más probable + score
 *   - email-verifier  → estado de entregabilidad con color semántico
 *   - -health-check   → header colapsado (interno)
 */

import type React from 'react';
import { Badge, getShortToolName, ToolCallCard } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { DomainSearchRenderer } from './hunter/DomainSearchRenderer';
import { EmailFinderRenderer } from './hunter/EmailFinderRenderer';
import { EmailVerifierRenderer } from './hunter/EmailVerifierRenderer';
import { HealthCheckRenderer } from './hunter/HealthCheckRenderer';
import { statusType, TOOL_VERBS } from './hunter/shared';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'domain-search': DomainSearchRenderer,
  'email-finder': EmailFinderRenderer,
  'email-verifier': EmailVerifierRenderer,
  '-health-check': HealthCheckRenderer,
};

/** Dev-only — should never render for a known tool. */
function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const short = getShortToolName(toolName);
  const badge =
    status === 'completed' ? (
      <Badge text="done" variant="success" />
    ) : status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : null;
  return (
    <ToolCallCard
      status={statusType(status)}
      verb={TOOL_VERBS[short] ?? short.replace(/-/g, ' ')}
      badge={badge}
      iconUri={appIcon}
    />
  );
}

function HunterRendererBase(props: ToolCallRendererProps) {
  const short = getShortToolName(props.toolName);
  const Renderer = RENDERERS[short] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const HunterToolCallRenderer = withPermissionSupport(HunterRendererBase);
export default HunterToolCallRenderer;
