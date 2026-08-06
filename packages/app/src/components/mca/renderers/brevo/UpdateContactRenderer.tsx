/**
 * Brevo — update-contact. Shows list add/remove deltas.
 */

import { YStack } from 'tamagui';
import {
  ErrorBlock,
  IconTile,
  PillList,
  ResourceCard,
  ToolCallCard,
  User,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type UpdateContactResult, narrowObject, useBrevoColors } from './shared';

export function UpdateContactRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<UpdateContactResult>(parseOutput<UpdateContactResult>(output)) : null;
  const identifier = data?.identifier ?? (typeof input?.identifier === 'string' ? input.identifier : '');
  const displayError = error || (status === 'failed' ? output : null);
  const added = data?.listIds ?? [];
  const removed = data?.unlinkListIds ?? [];

  return (
    <ToolCallCard
      status={status}
      verb="Update contact"
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
          title={identifier || '(contact)'}
          verb="updated"
        >
          {added.length > 0 || removed.length > 0 ? (
            <YStack gap={4}>
              {added.length > 0 ? (
                <PillList items={added.map((id) => `+ list ${id}`)} accent={colors.green} />
              ) : null}
              {removed.length > 0 ? (
                <PillList items={removed.map((id) => `− list ${id}`)} accent={c.text3} />
              ) : null}
            </YStack>
          ) : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
