/**
 * Brevo — list-email-campaigns.
 */

import { XStack, YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  Layers,
  MAX_ITEMS,
  Mail,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  BREVO_BRAND,
  type ListCampaignsResult,
  campaignStatusAccent,
  formatDate,
  narrowObject,
  useBrevoColors,
} from './shared';

export function ListCampaignsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const theme = useBrevoColors();
  const data = output ? narrowObject<ListCampaignsResult>(parseOutput<ListCampaignsResult>(output)) : null;
  const campaigns = data?.campaigns ?? [];
  const count = data?.count ?? campaigns.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge
        text={`${count} ${count === 1 ? 'campaign' : 'campaigns'}`}
        variant={count > 0 ? 'info' : 'gray'}
      />
    );

  const visible = campaigns.slice(0, MAX_ITEMS);
  const hasFilters = Boolean(data?.type || data?.status);

  return (
    <ToolCallCard
      status={status}
      verb="List campaigns"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && campaigns.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        campaigns.length > 0 ? (
          <YStack
            backgroundColor={theme.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={theme.border}
            overflow="hidden"
          >
            {hasFilters && (
              <XStack
                gap={6}
                paddingHorizontal={8}
                paddingVertical={6}
                borderBottomWidth={1}
                borderBottomColor={theme.border}
              >
                {data?.type && <IconChip text={`type: ${data.type}`} accent={BREVO_BRAND.royalBlue} />}
                {data?.status && (
                  <IconChip text={`status: ${data.status}`} accent={campaignStatusAccent(data.status)} />
                )}
              </XStack>
            )}
            {visible.map((c, i) => {
              const accent = campaignStatusAccent(c.status);
              const date = formatDate(c.scheduledAt) ?? formatDate(c.createdAt);
              return (
                <EntityRow
                  key={c.id ?? i}
                  leading={
                    <IconTile accent={accent} icon={<Layers size={14} color={accent} />} size={24} />
                  }
                  title={c.name ?? '(untitled)'}
                  subtitle={c.subject ?? undefined}
                  badges={
                    <XStack gap={4}>
                      {c.status && <IconChip text={c.status} accent={accent} />}
                      {c.type && <IconChip text={c.type} accent={theme.muted} />}
                    </XStack>
                  }
                  meta={date ? <IconChip text={date} accent={theme.muted} /> : undefined}
                />
              );
            })}
          </YStack>
        ) : (
          <Empty icon={<Mail size={20} color={theme.muted} />} message="No campaigns" />
        )
      ) : null}
    </ToolCallCard>
  );
}
