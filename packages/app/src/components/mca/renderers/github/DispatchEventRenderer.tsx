/**
 * GitHub Renderer — dispatch-event. Confirmation-only card; the workflow
 * runs that this triggers will appear separately under list-workflow-runs.
 */

import { Zap } from '../../primitives';
import { Text } from 'tamagui';

import {
  ErrorBlock,
  IconChip,
  IconTile,
  ResourceCard,
  colors as globalColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { GITHUB_PALETTE, GitHubToolShell } from './shared';

export function DispatchEventRenderer({ toolName, status, error, duration, input }: ToolCallRendererProps) {
  const owner = (input?.owner as string | undefined) ?? '?';
  const repo = (input?.repo as string | undefined) ?? '?';
  const eventType = (input?.event_type as string | undefined) ?? 'event';
  const hasPayload =
    input?.client_payload && typeof input.client_payload === 'object' && Object.keys(input.client_payload).length > 0;

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile icon={<Zap size={14} color={GITHUB_PALETTE.queued} />} accent={GITHUB_PALETTE.queued} size={28} />}
          title={eventType}
          subtitle={`${owner}/${repo}`}
          verb="created"
          meta={<IconChip text="dispatched" accent={GITHUB_PALETTE.queued} />}
        >
          <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
            repository_dispatch event sent{hasPayload ? ' (with payload)' : ''}. Any workflow with
            <Text> </Text>
            <Text fontWeight="600">on: repository_dispatch</Text>
            <Text> </Text>filtering on this type will start.
          </Text>
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
