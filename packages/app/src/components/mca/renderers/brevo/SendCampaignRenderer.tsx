/**
 * Brevo — send-email-campaign (sendNow). Irreversible send confirmation.
 */

import {
  CheckCircle,
  ErrorBlock,
  IconTile,
  ResourceCard,
  ToolCallCard,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { type SendCampaignResult, narrowObject } from './shared';

export function SendCampaignRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<SendCampaignResult>(parseOutput<SendCampaignResult>(output)) : null;
  const campaignId =
    data?.campaignId ?? (typeof input?.campaignId === 'number' ? input.campaignId : null);
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Send campaign"
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed'}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' && data?.sent ? (
        <ResourceCard
          leading={
            <IconTile
              accent={colors.green}
              icon={<CheckCircle size={16} color={colors.green} />}
              size={28}
            />
          }
          title="Campaign sent"
          subtitle={
            campaignId != null ? `id ${campaignId} · delivered to all recipients` : 'delivered to all recipients'
          }
        />
      ) : null}
    </ToolCallCard>
  );
}
