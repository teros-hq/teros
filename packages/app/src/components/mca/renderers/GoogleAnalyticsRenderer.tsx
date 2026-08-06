/**
 * Google Analytics 4 MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 13 tools + health-check (14 entries) covered. `FallbackRenderer` is a
 * dev-only warning signalling a missing entry in the RENDERERS map — in
 * production it should never render.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';

import {
  Badge,
  colors as globalColors,
  ErrorBlock,
  JsonPreview,
  ToolCallCard,
} from '../primitives';
import {
  BatchRunReportsRenderer,
  CreateDataStreamRenderer,
  CreatePropertyRenderer,
  DeletePropertyRenderer,
  GA_ICON,
  GetDataStreamRenderer,
  GetMetadataRenderer,
  GetPropertyRenderer,
  HealthCheckRenderer,
  ListAccountsRenderer,
  ListDataStreamsRenderer,
  ListPropertiesRenderer,
  RunRealtimeReportRenderer,
  RunReportRenderer,
  UpdatePropertyRenderer,
  getShortToolName,
  getToolLabel,
  toolStatusForPrimitive,
} from './google-analytics';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Registry — 14/14 coverage (13 tools + health-check)
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  // Admin: read
  'analytics-list-accounts': ListAccountsRenderer,
  'analytics-list-properties': ListPropertiesRenderer,
  'analytics-get-property': GetPropertyRenderer,
  'analytics-list-data-streams': ListDataStreamsRenderer,
  'analytics-get-data-stream': GetDataStreamRenderer,
  // Admin: write
  'analytics-create-property': CreatePropertyRenderer,
  'analytics-update-property': UpdatePropertyRenderer,
  'analytics-delete-property': DeletePropertyRenderer,
  'analytics-create-data-stream': CreateDataStreamRenderer,
  // Data API
  'analytics-run-report': RunReportRenderer,
  'analytics-batch-run-reports': BatchRunReportsRenderer,
  'analytics-run-realtime-report': RunRealtimeReportRenderer,
  'analytics-get-metadata': GetMetadataRenderer,
};

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={getToolLabel(toolName)}
      iconUri={GA_ICON}
      badge={badge}
      defaultExpanded={__DEV__}
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in GoogleAnalyticsRenderer.tsx.
          </Text>
        </YStack>
      )}
      {__DEV__ && output && <JsonPreview value={output} />}
      {error && <ErrorBlock error={error} />}
    </ToolCallCard>
  );
}

// ============================================================================
// Entry point
// ============================================================================

function GoogleAnalyticsRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const GoogleAnalyticsToolCallRenderer = withPermissionSupport(GoogleAnalyticsRendererBase);
export default GoogleAnalyticsToolCallRenderer;
