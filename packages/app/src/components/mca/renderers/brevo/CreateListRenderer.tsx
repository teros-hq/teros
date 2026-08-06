/**
 * Brevo — create-list.
 *
 * Shows the created list with the parent folder it was placed in.
 */

import {
  ErrorBlock,
  IconTile,
  KeyValueGrid,
  List,
  ResourceCard,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type CreateListResult, narrowObject } from './shared';

export function CreateListRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<CreateListResult>(parseOutput<CreateListResult>(output)) : null;
  const name = data?.name ?? (typeof input?.name === 'string' ? input.name : '');
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Create list"
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed'}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' && data ? (
        <ResourceCard
          leading={
            <IconTile
              accent={BREVO_BRAND.green}
              icon={<List size={16} color={BREVO_BRAND.green} />}
              size={28}
            />
          }
          title={name || '(unnamed list)'}
          subtitle={data.id != null ? `id ${data.id}` : undefined}
          verb="created"
        >
          <KeyValueGrid rows={[{ key: 'Folder', value: `id ${data.folderId}`, mono: true }]} />
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
