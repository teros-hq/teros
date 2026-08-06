/**
 * Brevo — list-contacts.
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  MAX_ITEMS,
  ToolCallCard,
  User,
  Users,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListContactsResult, contactDisplayName, narrowObject, useBrevoColors } from './shared';

export function ListContactsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const theme = useBrevoColors();
  const data = output ? narrowObject<ListContactsResult>(parseOutput<ListContactsResult>(output)) : null;
  const contacts = data?.contacts ?? [];
  const count = data?.count ?? contacts.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge text={`${count} ${count === 1 ? 'contact' : 'contacts'}`} variant={count > 0 ? 'info' : 'gray'} />
    );

  const visible = contacts.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List contacts"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && contacts.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        contacts.length > 0 ? (
          <YStack
            backgroundColor={theme.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={theme.border}
            overflow="hidden"
          >
            {visible.map((c, i) => {
              const name = contactDisplayName(c.attributes);
              const title = name ?? c.email ?? '(no email)';
              const subtitle = name ? (c.email ?? undefined) : c.id != null ? `id ${c.id}` : undefined;
              return (
                <EntityRow
                  key={c.id ?? c.email ?? i}
                  leading={
                    <IconTile
                      accent={BREVO_BRAND.royalBlue}
                      icon={<User size={14} color={BREVO_BRAND.royalBlue} />}
                      size={24}
                    />
                  }
                  title={title}
                  subtitle={subtitle}
                  badges={
                    c.emailBlacklisted ? <IconChip text="blocked" accent={theme.failed} /> : undefined
                  }
                  meta={
                    c.listIds.length > 0 ? (
                      <IconChip text={`${c.listIds.length} lists`} accent={BREVO_BRAND.green} />
                    ) : undefined
                  }
                />
              );
            })}
          </YStack>
        ) : (
          <Empty
            icon={<Users size={20} color={theme.muted} />}
            message="No contacts"
            hint="Create one with create-contact."
          />
        )
      ) : null}
    </ToolCallCard>
  );
}
