/**
 * Brevo — send-test-email. Confirms the test recipients.
 */

import {
  ErrorBlock,
  IconTile,
  Mail,
  PillList,
  ResourceCard,
  ToolCallCard,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type SendTestResult, narrowObject } from './shared';

export function SendTestRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<SendTestResult>(parseOutput<SendTestResult>(output)) : null;
  const emailTo = data?.emailTo ?? [];
  const campaignId =
    data?.campaignId ?? (typeof input?.campaignId === 'number' ? input.campaignId : null);
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolCallCard
      status={status}
      verb="Send test"
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
              accent={colors.green}
              icon={<Mail size={16} color={colors.green} />}
              size={28}
            />
          }
          title={`Test sent to ${emailTo.length} ${emailTo.length === 1 ? 'address' : 'addresses'}`}
          subtitle={campaignId != null ? `campaign id ${campaignId}` : undefined}
        >
          {emailTo.length > 0 ? <PillList items={emailTo} accent={BREVO_BRAND.royalBlue} /> : null}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
