/**
 * Brevo — get-email-event-report (per-message transactional email events).
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  Mail,
  MAX_ITEMS,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  type EmailEventReportResult,
  emailEventAccent,
  formatDate,
  narrowObject,
  useBrevoColors,
} from './shared';

export function EmailEventReportRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output
    ? narrowObject<EmailEventReportResult>(parseOutput<EmailEventReportResult>(output))
    : null;
  const events = data?.events ?? [];
  const count = data?.count ?? events.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge
        text={`${count} ${count === 1 ? 'event' : 'events'}`}
        variant={count > 0 ? 'info' : 'gray'}
      />
    );

  const visible = events.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="Get email events"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && events.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        events.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((e, i) => {
              const accent = emailEventAccent(e.event);
              return (
                <EntityRow
                  key={`${e.messageId ?? e.email ?? i}-${i}`}
                  leading={
                    <IconTile accent={accent} icon={<Mail size={13} color={accent} />} size={24} />
                  }
                  title={e.email ?? '(no recipient)'}
                  subtitle={formatDate(e.date) ?? e.subject ?? undefined}
                  meta={e.event ? <IconChip text={e.event} accent={accent} /> : undefined}
                />
              );
            })}
          </YStack>
        ) : (
          <Empty
            icon={<Mail size={20} color={c.muted} />}
            message="No events"
            hint="Widen the timeframe or remove filters."
          />
        )
      ) : null}
    </ToolCallCard>
  );
}
