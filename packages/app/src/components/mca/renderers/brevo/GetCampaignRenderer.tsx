/**
 * Brevo — get-email-campaign (detail of one campaign).
 */

import {
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  Layers,
  ResourceCard,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { KeyValueRow } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { type CampaignItem, campaignStatusAccent, formatDate, narrowObject } from './shared';

export function GetCampaignRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<CampaignItem>(parseOutput<CampaignItem>(output)) : null;
  const displayError = error || (status === 'failed' ? output : null);
  const accent = campaignStatusAccent(data?.status);
  const date = data ? (formatDate(data.scheduledAt) ?? formatDate(data.createdAt)) : null;

  const rows: KeyValueRow[] = [];
  if (data?.type) rows.push({ key: 'Type', value: data.type });
  if (date) rows.push({ key: 'Date', value: date });

  return (
    <ToolCallCard
      status={status}
      verb="Get campaign"
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed'}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' && data ? (
        <ResourceCard
          leading={<IconTile accent={accent} icon={<Layers size={16} color={accent} />} size={28} />}
          title={data.name ?? '(untitled)'}
          subtitle={data.subject ?? undefined}
          meta={data.status ? <IconChip text={data.status} accent={accent} /> : undefined}
        >
          {rows.length > 0 ? <KeyValueGrid rows={rows} /> : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
