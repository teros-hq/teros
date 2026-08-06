/**
 * Brevo — get-contact (detail of one contact).
 */

import {
  Empty,
  ErrorBlock,
  IconChip,
  IconTile,
  PillList,
  ResourceCard,
  ToolCallCard,
  User,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ContactItem, contactDisplayName, narrowObject } from './shared';

export function GetContactRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<ContactItem>(parseOutput<ContactItem>(output)) : null;
  const displayError = error || (status === 'failed' ? output : null);
  const name = data ? contactDisplayName(data.attributes) : null;

  return (
    <ToolCallCard
      status={status}
      verb="Get contact"
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
              accent={BREVO_BRAND.royalBlue}
              icon={<User size={16} color={BREVO_BRAND.royalBlue} />}
              size={28}
            />
          }
          title={name ?? data.email ?? '(no email)'}
          subtitle={name ? (data.email ?? undefined) : data.id != null ? `id ${data.id}` : undefined}
          meta={
            data.emailBlacklisted ? <IconChip text="blocked" accent={colors.red} /> : undefined
          }
        >
          {data.listIds.length > 0 ? (
            <PillList items={data.listIds.map((id) => `list ${id}`)} accent={BREVO_BRAND.green} />
          ) : (
            <Empty message="No lists" />
          )}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
