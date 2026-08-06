/**
 * Railway Renderer - Domains
 *
 * Handles: railway-list-domains, railway-create-domain
 */

import type React from 'react';
import { Linking } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRailwayColors,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface DomainRowProps {
  domain: string;
  id?: string;
}

function DomainRow({ domain, id }: DomainRowProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const url = domain.startsWith('http') ? domain : `https://${domain}`;

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      cursor="pointer"
      onPress={() => Linking.openURL(url)}
    >
      <XStack
        width={6}
        height={6}
        borderRadius={3}
        backgroundColor={colors.railwayRed}
        flexShrink={0}
      />
      <Text flex={1} color={colors.railwayRed} fontSize={10} fontFamily="$mono" numberOfLines={1}>
        {domain}
      </Text>
      {id && (
        <Text color={c.text3} fontSize={8} fontFamily="$mono" numberOfLines={1}>
          {truncate(id, 16)}
        </Text>
      )}
    </XStack>
  );
}

// Parse domains from markdown output
function parseDomainsFromMarkdown(text: string): Array<{ domain: string; id: string }> {
  const results: Array<{ domain: string; id: string }> = [];
  // Match lines like: - **domain** (id)
  const regex = /- \*\*([^*]+)\*\*\s*\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ domain: match[1], id: match[2] });
  }
  return results;
}

// ============================================================================
// Renderers
// ============================================================================

export function ListDomainsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const domains = typeof parsed === 'string' ? parseDomainsFromMarkdown(parsed) : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && domains.length > 0) {
    badge = <Badge text={`${domains.length} domains`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List domains';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {domains.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {domains.map((d, i) => (
              <DomainRow key={i} domain={d.domain} id={d.id} />
            ))}
          </YStack>
        )}
        {typeof parsed === 'string' && domains.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>
              {parsed}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateDomainRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output
    ? parseOutput<{ message: string; domain: string; url: string }>(output)
    : null;
  const isResult =
    parsed && typeof parsed === 'object' && 'domain' in parsed;

  const domainValue = isResult ? (parsed as any).domain : null;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = domainValue
    ? truncate(domainValue, 30)
    : 'Create domain';

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={(parsed as any).message} />
            {domainValue && (
              <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
                <DomainRow domain={domainValue} />
              </YStack>
            )}
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
