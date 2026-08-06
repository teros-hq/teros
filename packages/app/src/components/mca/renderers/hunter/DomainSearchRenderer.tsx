/**
 * mca.hunter — domain-search sub-renderer
 * Lista de emails encontrados para un dominio (EntityRow + confidence badge).
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  KeyValueGrid,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  confidenceChipProps,
  type DomainSearchOutput,
  fullName,
  HunterToolShell,
  hunterErrorProps,
  LIST_RENDER_CAP,
  unwrap,
} from './shared';

export function DomainSearchRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { toolName, input, status, output, error, appIcon } = props;
  const c = useColors();
  const data = unwrap<DomainSearchOutput>(output);
  const domain = data?.domain || (input?.domain as string) || '';
  const isFailed = status === 'failed';
  const displayError = error || (isFailed ? output : null) || undefined;

  const emails = (data?.emails ?? []).slice(0, LIST_RENDER_CAP);
  const verb = domain ? `Find emails for ${domain}` : 'Find emails';

  const badge = isFailed ? (
    <Badge text="failed" variant="error" />
  ) : data ? (
    <Badge text={`${data.total}`} variant={data.total > 0 ? 'info' : 'gray'} />
  ) : undefined;

  return (
    <HunterToolShell toolName={toolName} status={status} appIcon={appIcon} verb={verb} badge={badge}>
      {displayError ? (
        <ErrorBlock {...hunterErrorProps(displayError, 'domain-search')} />
      ) : data ? (
        <YStack gap={8}>
          {(data.organization || data.pattern) && (
            <KeyValueGrid
              rows={[
                ...(data.organization
                  ? [{ key: 'Organization', value: data.organization }]
                  : []),
                ...(data.pattern ? [{ key: 'Pattern', value: data.pattern, mono: true }] : []),
              ]}
            />
          )}

          {emails.length > 0 ? (
            <YStack
              backgroundColor={c.bgInner}
              borderRadius={6}
              borderWidth={1}
              borderColor={c.border}
              overflow="hidden"
            >
              {emails.map((e, idx) => {
                const chip = confidenceChipProps(e.confidence);
                const name = fullName(e.firstName, e.lastName);
                const subtitle = [name, e.position].filter(Boolean).join(' · ');
                return (
                  <EntityRow
                    key={e.value || idx}
                    title={e.value}
                    subtitle={subtitle || undefined}
                    badges={
                      <XStack gap={4} alignItems="center">
                        {e.type ? <Badge text={e.type} variant="gray" /> : null}
                        {chip ? <Badge text={chip.text} variant={chip.variant} /> : null}
                      </XStack>
                    }
                  />
                );
              })}
            </YStack>
          ) : (
            <Empty message={`No emails found for ${domain || 'this domain'}`} />
          )}

          {data.total > emails.length && (
            <Text color={c.text3} fontSize={10}>
              Showing {emails.length} of {data.total}
            </Text>
          )}
        </YStack>
      ) : null}
    </HunterToolShell>
  );
}
