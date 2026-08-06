/**
 * mca.hunter — email-verifier sub-renderer
 * Estado de entregabilidad de un email con color semántico + checks técnicos.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  checkChipProps,
  type EmailVerifierOutput,
  HunterToolShell,
  hunterErrorProps,
  unwrap,
  verifierResultProps,
  verifierStatusProps,
} from './shared';

export function EmailVerifierRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { toolName, input, status, output, error, appIcon } = props;
  const c = useColors();
  const data = unwrap<EmailVerifierOutput>(output);
  const email = data?.email || (input?.email as string) || '';
  const isFailed = status === 'failed';
  const displayError = error || (isFailed ? output : null) || undefined;

  const verb = email ? `Verify ${email}` : 'Verify email';

  const resultChip = data ? verifierResultProps(data.result) : null;
  const badge = isFailed ? (
    <Badge text="failed" variant="error" />
  ) : resultChip ? (
    <Badge text={resultChip.text} variant={resultChip.variant} />
  ) : undefined;

  const statusChip = data ? verifierStatusProps(data.status) : null;

  return (
    <HunterToolShell toolName={toolName} status={status} appIcon={appIcon} verb={verb} badge={badge}>
      {displayError ? (
        <ErrorBlock {...hunterErrorProps(displayError, 'email-verifier')} />
      ) : data ? (
        <YStack gap={8}>
          <XStack alignItems="center" gap={8} flexWrap="wrap">
            <Text color={c.text} fontSize={12} fontWeight="600" fontFamily="$mono">
              {data.email}
            </Text>
            {statusChip ? <Badge text={statusChip.text} variant={statusChip.variant} /> : null}
            {data.score !== null ? (
              <Text color={c.text2} fontSize={10}>
                score {data.score}
              </Text>
            ) : null}
          </XStack>

          <XStack gap={4} flexWrap="wrap">
            <Badge {...checkChipProps('MX', data.mxRecords)} />
            <Badge {...checkChipProps('SMTP', data.smtpServer)} />
            <Badge {...checkChipProps('SMTP check', data.smtpCheck)} />
            {data.acceptAll ? <Badge text="accept-all" variant="warning" /> : null}
            {data.webmail ? <Badge text="webmail" variant="warning" /> : null}
            {data.disposable ? <Badge text="disposable" variant="error" /> : null}
            {data.gibberish ? <Badge text="gibberish" variant="warning" /> : null}
            {data.block ? <Badge text="blocked" variant="error" /> : null}
          </XStack>
        </YStack>
      ) : null}
    </HunterToolShell>
  );
}
