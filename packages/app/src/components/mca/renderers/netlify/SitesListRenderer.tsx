/**
 * Sites List Renderer — `list-sites`.
 *
 * One row per Netlify site: name + clickable URL + short id.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, Empty, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { parseOutput, prettyHost, UrlLink, useNetlifyColors } from './shared';

interface NetlifySite {
  id: string;
  name: string;
  url: string | null;
  ssl_url: string | null;
}

interface ListSitesOutput {
  sites: NetlifySite[];
}

export function SitesListRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactElement {
  const c = useNetlifyColors();
  const data = parseOutput<ListSitesOutput>(output);
  const sites = data?.sites ?? [];
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge text={`${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`} variant={sites.length > 0 ? 'info' : 'gray'} />
    );

  return (
    <ToolCallCard status={status} verb="List sites" badge={badge} iconUri={appIcon}>
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : sites.length === 0 ? (
        <Empty message="No sites found" />
      ) : (
        <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          {sites.map((site, idx) => {
            const link = site.ssl_url ?? site.url;
            return (
              <YStack
                key={site.id || idx}
                paddingVertical={7}
                paddingHorizontal={10}
                gap={3}
                borderBottomWidth={idx < sites.length - 1 ? 1 : 0}
                borderBottomColor={c.border}
              >
                <XStack alignItems="center" gap={8}>
                  <Text color={c.text} fontSize={11} fontWeight="500" flex={1} numberOfLines={1}>
                    {site.name}
                  </Text>
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" numberOfLines={1}>
                    {site.id.slice(0, 8)}
                  </Text>
                </XStack>
                {link ? (
                  <UrlLink url={link} label={prettyHost(link)} size={10} />
                ) : (
                  <Text color={c.text3} fontSize={10}>
                    no url
                  </Text>
                )}
              </YStack>
            );
          })}
        </YStack>
      )}
    </ToolCallCard>
  );
}
