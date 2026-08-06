/**
 * GA4 Renderer — Accounts. analytics-list-accounts.
 */

import { Building2 } from '@tamagui/lucide-icons';
import { ScrollView, Text, YStack } from 'tamagui';

import {
  Empty,
  ErrorBlock,
  IconTile,
  EntityRow,
  MetaStrip,
  parseOutput,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { GA_BRAND, type GAAccount, formatDate, GoogleAnalyticsToolShell, useScrollStyle } from './shared';

interface ListAccountsOutput {
  account?: string;
  count: number;
  accounts: GAAccount[];
  nextPageToken?: string;
}

export function ListAccountsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useColors();
  const raw = output ? parseOutput(output) : null;
  const parsed: ListAccountsOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ListAccountsOutput) : null;
  const accounts = parsed?.accounts ?? [];
  const scrollStyle = useScrollStyle(360);

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={accounts.length > 0 ? `${accounts.length} accounts` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && accounts.length === 0 && <Empty message="No accounts" />}
      {!error && accounts.length > 0 && (
        <ScrollView style={scrollStyle}>
          <YStack>
            {accounts.map((acc: GAAccount) => {
              const metaPills: { key: string; value: string }[] = [];
              if (acc.regionCode) metaPills.push({ key: 'region', value: acc.regionCode });
              if (acc.createTime) {
                const created = formatDate(acc.createTime);
                if (created) metaPills.push({ key: 'created', value: created });
              }
              return (
                <EntityRow
                  key={acc.accountId ?? acc.name}
                  leading={
                    <IconTile
                      accent={GA_BRAND.orange}
                      icon={<Building2 size={14} color={GA_BRAND.orange} />}
                      size={26}
                    />
                  }
                  title={acc.displayName ?? acc.name ?? '—'}
                  subtitle={acc.accountId ? `accounts/${acc.accountId}` : undefined}
                  meta={metaPills.length > 0 ? <MetaStrip items={metaPills} /> : null}
                />
              );
            })}
          </YStack>
        </ScrollView>
      )}
      {!error && parsed?.nextPageToken && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          + more available (use pageToken to paginate)
        </Text>
      )}
    </GoogleAnalyticsToolShell>
  );
}
