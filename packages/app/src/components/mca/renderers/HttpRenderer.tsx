/**
 * HTTP Request MCA (`mca.teros.http`) — custom Tool Call Renderer.
 *
 * A generic HTTP client with exactly two tools, so coverage is 100% with two
 * dedicated sub-renderers and NO FallbackRenderer:
 *   - `http-request`   → RequestRenderer   (method/host header, status badge,
 *                        response meta + body)
 *   - `-health-check`  → HealthCheckRenderer (SDK contract, shipped in every MCA)
 *
 * `http-request` is the primary tool, so it doubles as the safe default if the
 * short-name resolution ever drifts — there is nothing else to fall back to.
 */

import type React from 'react';
import { getShortToolName } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { HealthCheckRenderer } from './http/HealthCheckRenderer';
import { RequestRenderer } from './http/RequestRenderer';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'http-request': RequestRenderer,
  '-health-check': HealthCheckRenderer,
};

function HttpRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? RequestRenderer;
  return <Renderer {...props} />;
}

export const HttpToolCallRenderer = withPermissionSupport(HttpRendererBase);
export default HttpToolCallRenderer;
