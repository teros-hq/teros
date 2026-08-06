/**
 * mca.make — trigger-webhook sub-renderer.
 *
 * Shows the delivery result: a status-code badge, a MetaStrip (host · region ·
 * status) and the scenario response (JSON → CodeBlock, text → mono). The
 * tokenized webhook URL is NEVER rendered — only the host (from the backend, or
 * derived host-only from the input as a fallback).
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { CodeBlock } from '../../CodeBlock';
import { Badge, ErrorBlock, MetaStrip } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { hostFromWebhookUrl, MakeToolShell, parseMakeOutput, useMakeColors, type WebhookResultOutput } from './shared';

function ResponseBlock({ data }: { data: WebhookResultOutput }): React.ReactNode {
  const c = useMakeColors();
  if (data.responseType === 'json') {
    const text = JSON.stringify(data.response, null, 2);
    if (!text || text === '""' || text === 'null' || text === '{}') return null;
    return <CodeBlock code={text} language="json" maxHeight={220} />;
  }
  const text = typeof data.response === 'string' ? data.response : String(data.response ?? '');
  if (!text.trim()) return null;
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={6} paddingVertical={6} paddingHorizontal={8}>
      <Text color={c.text} fontSize={11} fontFamily="$mono">
        {text}
      </Text>
    </YStack>
  );
}

export function WebhookResultRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactNode {
  const data = parseMakeOutput<WebhookResultOutput>(output);
  const failed = status === 'failed';
  const host = data?.webhookHost || hostFromWebhookUrl(input?.webhookUrl);

  const badge = failed ? (
    <Badge text="failed" variant="error" />
  ) : data ? (
    <Badge text={String(data.statusCode)} variant="success" />
  ) : undefined;

  return (
    <MakeToolShell
      toolName="trigger-webhook"
      status={status}
      appIcon={appIcon}
      badge={badge}
      defaultExpanded={!failed && Boolean(data)}
    >
      {failed ? (
        <ErrorBlock message={error || output || 'Webhook failed'} title="Webhook failed" />
      ) : data ? (
        <YStack gap={8}>
          <MetaStrip
            items={[
              ...(host ? [{ key: 'host', value: host }] : []),
              ...(data.region ? [{ key: 'region', value: data.region }] : []),
              { key: 'status', value: String(data.statusCode) },
            ]}
          />
          <ResponseBlock data={data} />
        </YStack>
      ) : null}
    </MakeToolShell>
  );
}
