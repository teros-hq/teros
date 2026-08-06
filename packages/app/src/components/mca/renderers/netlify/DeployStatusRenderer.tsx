/**
 * Deploy Status Renderer — `get-deploy-status`.
 *
 * Shows the deploy state (semantic dot + badge), the URL when available, and
 * the upstream error message when the deploy failed.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  deployStateColor,
  deployStateVariant,
  parseOutput,
  prettyHost,
  UrlLink,
  useNetlifyColors,
} from './shared';

interface DeployStatusOutput {
  state: string;
  url: string | null;
  errorMessage: string | null;
  deployId: string;
  siteId: string;
}

export function DeployStatusRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactElement {
  const c = useNetlifyColors();
  const data = parseOutput<DeployStatusOutput>(output);
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : data?.state ? (
      <Badge text={data.state} variant={deployStateVariant(data.state)} />
    ) : null;

  return (
    <ToolCallCard status={status} verb="Check deploy status" badge={badge} iconUri={appIcon}>
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : (
        data && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            paddingVertical={9}
            paddingHorizontal={11}
            gap={7}
          >
            <XStack alignItems="center" gap={7}>
              {/* Semantic deploy-state dot (StatusDot maps tool status, not
                  deploy state, so we paint a plain colored dot here). */}
              <YStack
                width={7}
                height={7}
                borderRadius={4}
                backgroundColor={deployStateColor(data.state, c)}
              />
              <Text color={c.text} fontSize={11} fontFamily="$mono">
                {data.state}
              </Text>
              <Text color={c.text3} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1} textAlign="right">
                {data.deployId.slice(0, 12)}
              </Text>
            </XStack>

            {data.url && <UrlLink url={data.url} label={prettyHost(data.url)} size={11} />}

            {data.errorMessage && <ErrorBlock error={data.errorMessage} />}
          </YStack>
        )
      )}
    </ToolCallCard>
  );
}
