/**
 * Brevo — delete-contact. Irreversible removal confirmation.
 */

import {
  ErrorBlock,
  IconTile,
  ResourceCard,
  ToolCallCard,
  Trash2,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { type DeleteContactResult, narrowObject } from './shared';

export function DeleteContactRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<DeleteContactResult>(parseOutput<DeleteContactResult>(output)) : null;
  const identifier = data?.identifier ?? (typeof input?.identifier === 'string' ? input.identifier : '');
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Delete contact"
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed'}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' && data?.deleted ? (
        <ResourceCard
          leading={
            <IconTile
              accent={colors.red}
              icon={<Trash2 size={16} color={colors.red} />}
              size={28}
            />
          }
          title={identifier || '(contact)'}
          subtitle="deleted"
        />
      ) : null}
    </ToolCallCard>
  );
}
