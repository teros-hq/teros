/**
 * Brevo — get-aggregated-smtp-report (transactional email totals for a timeframe).
 */

import { XStack } from 'tamagui';
import {
  Badge,
  Empty,
  ErrorBlock,
  IconChip,
  IconTile,
  Presentation,
  ResourceCard,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  BREVO_BRAND,
  type AggregatedSmtpReportResult,
  aggregatedReportStats,
  narrowObject,
} from './shared';

export function AggregatedReportRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output
    ? narrowObject<AggregatedSmtpReportResult>(parseOutput<AggregatedSmtpReportResult>(output))
    : null;
  const displayError = error || (status === 'failed' ? output : null);
  const stats = data ? aggregatedReportStats(data) : [];

  const badge =
    status === 'failed' ? <Badge text="failed" variant="error" /> : null;

  return (
    <ToolCallCard
      status={status}
      verb="Get email stats"
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
              accent={BREVO_BRAND.royalBlue}
              icon={<Presentation size={16} color={BREVO_BRAND.royalBlue} />}
              size={28}
            />
          }
          title="Transactional email totals"
          subtitle={data.range ?? undefined}
        >
          {stats.length > 0 ? (
            <XStack flexWrap="wrap" gap={6}>
              {stats.map((s) => (
                <IconChip key={s.label} text={`${s.value} ${s.label}`} accent={s.accent} />
              ))}
            </XStack>
          ) : (
            <Empty message="No stats" />
          )}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
