/**
 * Brevo — create-contact.
 *
 * Shows the created (or updated) contact. `updated` (true when Brevo returned
 * no id because the contact already existed + updateEnabled) drives the
 * created/updated ActionBadge.
 */

import {
  Empty,
  ErrorBlock,
  IconTile,
  PillList,
  ResourceCard,
  ToolCallCard,
  UserPlus,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type CreateContactResult, narrowObject } from './shared';

export function CreateContactRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<CreateContactResult>(parseOutput<CreateContactResult>(output)) : null;
  const email = data?.email ?? (typeof input?.email === 'string' ? input.email : '');
  const updated = data?.updated === true;
  const listIds = data?.listIds ?? [];
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Create contact"
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
              icon={<UserPlus size={16} color={BREVO_BRAND.green} />}
              size={28}
            />
          }
          title={email || '(no email)'}
          subtitle={data.id != null ? `id ${data.id}` : undefined}
          verb={updated ? 'updated' : 'created'}
        >
          {listIds.length > 0 ? (
            <PillList items={listIds.map((id) => `list ${id}`)} accent={BREVO_BRAND.royalBlue} />
          ) : (
            <Empty message="No lists assigned" />
          )}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
