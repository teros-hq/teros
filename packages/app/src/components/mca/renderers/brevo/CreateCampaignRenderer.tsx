/**
 * Brevo — create-email-campaign.
 *
 * Draft vs scheduled is the meaningful distinction, shown as a chip.
 */

import {
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  Mail,
  ResourceCard,
  ToolCallCard,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type CreateCampaignResult, formatDate, narrowObject, useBrevoColors } from './shared';

export function CreateCampaignRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<CreateCampaignResult>(parseOutput<CreateCampaignResult>(output)) : null;
  const name = data?.name ?? (typeof input?.name === 'string' ? input.name : '');
  const displayError = error || (status === 'failed' ? output : null);
  const scheduled = data?.scheduledAt ? formatDate(data.scheduledAt) : null;

  return (
    <ToolCallCard
      status={status}
      verb="Create campaign"
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
              icon={<Mail size={16} color={BREVO_BRAND.royalBlue} />}
              size={28}
            />
          }
          title={name || '(untitled campaign)'}
          subtitle={data.id != null ? `id ${data.id}` : undefined}
          verb="created"
          meta={
            <IconChip
              text={scheduled ? `scheduled ${scheduled}` : 'draft'}
              accent={scheduled ? BREVO_BRAND.green : c.text3}
            />
          }
        >
          {data.subject ? <KeyValueGrid rows={[{ key: 'Subject', value: data.subject }]} /> : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
