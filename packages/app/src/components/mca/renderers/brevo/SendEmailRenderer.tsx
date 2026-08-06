/**
 * Brevo — send-transactional-email.
 *
 * Confirmation card for a sent transactional email: subject, sender,
 * recipients and the returned messageId. Backend returns data; this composes
 * the sentence (Renderer UX Guide — backend = data, frontend = UI).
 */

import { Text, YStack } from 'tamagui';
import {
  Badge,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  Mail,
  PillList,
  ResourceCard,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, narrowObject, recipientLabel, type SendEmailResult, useBrevoColors } from './shared';

export function SendEmailRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<SendEmailResult>(parseOutput<SendEmailResult>(output)) : null;
  const subject = data?.subject ?? (typeof input?.subject === 'string' ? input.subject : '');
  const recipients = data?.recipients ?? [];
  const count = data?.recipientCount ?? recipients.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : data?.messageId ? (
      <Badge text="sent" variant="success" />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      verb="Send email"
      badge={badge}
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
              icon={<Mail size={16} color={BREVO_BRAND.green} />}
              size={28}
            />
          }
          title={subject || '(no subject)'}
          subtitle={data.sender ? `from ${recipientLabel(data.sender)}` : undefined}
          meta={
            count > 0 ? (
              <IconChip
                text={`${count} ${count === 1 ? 'recipient' : 'recipients'}`}
                accent={BREVO_BRAND.green}
              />
            ) : undefined
          }
        >
          {recipients.length > 0 && (
            <YStack gap={4}>
              <Text color={c.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                to
              </Text>
              <PillList items={recipients.map(recipientLabel)} accent={BREVO_BRAND.green} />
            </YStack>
          )}
          {data.messageId && <KeyValueGrid rows={[{ key: 'messageId', value: data.messageId }]} />}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
