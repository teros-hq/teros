/**
 * Brevo — add-contact-to-list. Success / failure of the membership change.
 */

import {
  ErrorBlock,
  IconChip,
  IconTile,
  PillList,
  ResourceCard,
  ToolCallCard,
  Users,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type MembershipResult, narrowObject } from './shared';

export function AddToListRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<MembershipResult>(parseOutput<MembershipResult>(output)) : null;
  const listId = data?.listId ?? (typeof input?.listId === 'number' ? input.listId : null);
  const success = data?.success ?? [];
  const failure = data?.failure ?? [];
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Add to list"
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
              icon={<Users size={16} color={BREVO_BRAND.green} />}
              size={28}
            />
          }
          title={`${success.length} added`}
          subtitle={failure.length > 0 ? `${failure.length} failed` : undefined}
          meta={listId != null ? <IconChip text={`list ${listId}`} accent={BREVO_BRAND.royalBlue} /> : undefined}
        >
          {success.length > 0 ? (
            <PillList items={success.map(String)} accent={colors.green} />
          ) : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
