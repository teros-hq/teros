/**
 * mca.hunter — email-finder sub-renderer
 * Email más probable de una persona + score de confianza (ResourceCard-style).
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, KeyValueGrid, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  type EmailFinderOutput,
  fullName,
  HunterToolShell,
  hunterErrorProps,
  scoreChipProps,
  unwrap,
  verifierStatusProps,
} from './shared';

export function EmailFinderRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { toolName, input, status, output, error, appIcon } = props;
  const c = useColors();
  const data = unwrap<EmailFinderOutput>(output);
  const isFailed = status === 'failed';
  const displayError = error || (isFailed ? output : null) || undefined;

  const name =
    fullName(data?.firstName ?? null, data?.lastName ?? null) ||
    fullName((input?.first_name as string) ?? null, (input?.last_name as string) ?? null);
  const verb = name ? `Find email for ${name}` : 'Find email';

  const scoreChip = data ? scoreChipProps(data.score) : null;
  const badge = isFailed ? (
    <Badge text="failed" variant="error" />
  ) : data?.email ? (
    scoreChip ? <Badge text={scoreChip.text} variant={scoreChip.variant} /> : undefined
  ) : data ? (
    <Badge text="no match" variant="gray" />
  ) : undefined;

  const verification = data ? verifierStatusProps(data.verificationStatus) : null;

  return (
    <HunterToolShell toolName={toolName} status={status} appIcon={appIcon} verb={verb} badge={badge}>
      {displayError ? (
        <ErrorBlock {...hunterErrorProps(displayError, 'email-finder')} />
      ) : data?.email ? (
        <YStack gap={8}>
          <XStack alignItems="center" gap={8} flexWrap="wrap">
            <Text color={c.text} fontSize={13} fontWeight="600" fontFamily="$mono">
              {data.email}
            </Text>
            {verification ? <Badge text={verification.text} variant={verification.variant} /> : null}
          </XStack>
          <KeyValueGrid
            rows={[
              ...(name ? [{ key: 'Name', value: name }] : []),
              ...(data.position ? [{ key: 'Position', value: data.position }] : []),
              ...(data.company ? [{ key: 'Company', value: data.company }] : []),
              ...(data.domain ? [{ key: 'Domain', value: data.domain, mono: true }] : []),
              ...(data.linkedin ? [{ key: 'LinkedIn', value: data.linkedin, mono: true }] : []),
              ...(data.twitter ? [{ key: 'Twitter', value: `@${data.twitter}`, mono: true }] : []),
            ]}
          />
        </YStack>
      ) : data ? (
        <Text color={c.text2} fontSize={11}>
          No confident email match for {name || 'this person'}.
        </Text>
      ) : null}
    </HunterToolShell>
  );
}
