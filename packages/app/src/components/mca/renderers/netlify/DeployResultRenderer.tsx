/**
 * Deploy Result Renderer — `deploy-site`.
 *
 * The star tool: surfaces the public deploy URL prominently (clickable) plus a
 * compact meta grid (site, deploy id, files, mode). Backend returns data only;
 * the header sentence + state phrasing are composed here.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import {
  Badge,
  ErrorBlock,
  KeyValueGrid,
  type KeyValueRow,
  ToolCallCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  deployStateVariant,
  parseOutput,
  prettyHost,
  UrlLink,
  useNetlifyColors,
} from './shared';

interface DeployResult {
  url: string | null;
  deployId: string;
  state: string;
  siteId: string;
  siteName: string | null;
  draft: boolean;
  fileCount: number;
  uploadedCount: number;
}

export function DeployResultRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactElement {
  const c = useNetlifyColors();
  const data = parseOutput<DeployResult>(output);
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : data?.state ? (
      <Badge text={data.state} variant={deployStateVariant(data.state)} />
    ) : null;

  const rows: KeyValueRow[] = data
    ? [
        { key: 'site', value: data.siteName ?? data.siteId },
        { key: 'deploy', value: data.deployId },
        { key: 'files', value: `${data.uploadedCount} uploaded · ${data.fileCount} total` },
        { key: 'mode', value: data.draft ? 'draft preview' : 'production' },
      ]
    : [];

  return (
    <ToolCallCard status={status} verb="Deploy site" badge={badge} iconUri={appIcon}>
      <YStack gap={8}>
        {displayError ? (
          <ErrorBlock error={displayError} />
        ) : (
          data && (
            <>
              {/* Prominent public URL */}
              <YStack
                backgroundColor={c.bgInner}
                borderRadius={6}
                borderWidth={1}
                borderColor={`${c.teal}40`}
                paddingVertical={10}
                paddingHorizontal={12}
                gap={4}
              >
                <Text color={c.text3} fontSize={9} textTransform="uppercase" fontFamily="$mono">
                  {data.draft ? 'preview url' : 'live url'}
                </Text>
                {data.url ? (
                  <UrlLink url={data.url} label={prettyHost(data.url)} size={13} bold />
                ) : (
                  <Text color={c.text3} fontSize={11}>
                    URL not available yet
                  </Text>
                )}
              </YStack>

              {/* Meta */}
              <KeyValueGrid rows={rows} />
            </>
          )
        )}
      </YStack>
    </ToolCallCard>
  );
}
