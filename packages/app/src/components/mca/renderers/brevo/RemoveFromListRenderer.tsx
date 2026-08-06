/**
 * Brevo — remove-contact-from-list. Success / failure of the membership change.
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
import { BREVO_BRAND, type MembershipResult, narrowObject, useBrevoColors } from './shared';

export function RemoveFromListRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<MembershipResult>(parseOutput<MembershipResult>(output)) : null;
  const listId = data?.listId ?? (typeof input?.listId === 'number' ? input.listId : null);
  const success = data?.success ?? [];
  const failure = data?.failure ?? [];
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Remove from list"
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
              accent={c.text3}
              icon={<Users size={16} color={c.text3} />}
              size={28}
            />
          }
          title={`${success.length} removed`}
          subtitle={failure.length > 0 ? `${failure.length} failed` : undefined}
          meta={listId != null ? <IconChip text={`list ${listId}`} accent={BREVO_BRAND.royalBlue} /> : undefined}
        >
          {success.length > 0 ? (
            <PillList items={success.map(String)} accent={c.text3} />
          ) : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
