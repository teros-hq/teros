/**
 * GA4 Renderer — Reports + Metadata. run-report, batch-run-reports,
 * run-realtime-report, get-metadata.
 */

import { BarChart3, Database, Radio } from '@tamagui/lucide-icons';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import {
  colors as globalColors,
  Empty,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  parseOutput,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GA_BRAND,
  type GAReport,
  formatMetric,
  GoogleAnalyticsToolShell,
  useScrollStyle,
} from './shared';

// ============================================================================
// Report table — composes EntityRow-like rows with KeyValueGrid for metadata
// ============================================================================

function ReportTable({ report }: { report: GAReport }) {
  const c = useColors();
  const dimNames = report.dimensionHeaders.map((h) => h.name);
  const metricNames = report.metricHeaders.map((h) => h.name);
  const metricTypes = report.metricHeaders.map((h) => h.type);
  const rows = report.rows ?? [];
  const scrollStyle = useScrollStyle(400);

  if (rows.length === 0) return <Empty message="No rows" />;

  return (
    <YStack gap={4}>
      <XStack
        gap={8}
        paddingVertical={4}
        borderBottomWidth={1}
        borderBottomColor={c.borderStrong}
      >
        {dimNames.map((d) => (
          <Text
            key={`d-${d}`}
            flex={1}
            color={c.text3}
            fontSize={9}
            fontFamily="$mono"
            textTransform="uppercase"
          >
            {d}
          </Text>
        ))}
        {metricNames.map((m) => (
          <Text
            key={`m-${m}`}
            color={GA_BRAND.amber}
            fontSize={9}
            fontFamily="$mono"
            textTransform="uppercase"
            textAlign="right"
            minWidth={70}
          >
            {m}
          </Text>
        ))}
      </XStack>
      <ScrollView style={scrollStyle}>
        <YStack>
          {rows.map((row, i) => (
            <XStack
              // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list of report rows
              key={i}
              gap={8}
              paddingVertical={4}
              borderBottomWidth={1}
              borderBottomColor={c.border}
            >
              {row.dimensionValues.map((dv, j) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable
                  key={`r-${i}-d-${j}`}
                  flex={1}
                  color={c.text2}
                  fontSize={10}
                  numberOfLines={1}
                >
                  {dv || '—'}
                </Text>
              ))}
              {row.metricValues.map((mv, j) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable
                  key={`r-${i}-m-${j}`}
                  color={c.text}
                  fontSize={10}
                  fontFamily="$mono"
                  textAlign="right"
                  minWidth={70}
                >
                  {formatMetric(mv, metricTypes[j])}
                </Text>
              ))}
            </XStack>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  );
}

function reportMetaItems(report: GAReport): { key: string; value: string }[] {
  const items: { key: string; value: string }[] = [];
  if (report.metadata?.timeZone) items.push({ key: 'timezone', value: report.metadata.timeZone });
  if (report.metadata?.currencyCode) {
    items.push({ key: 'currency', value: report.metadata.currencyCode });
  }
  if (report.rowCount != null) items.push({ key: 'rowCount', value: String(report.rowCount) });
  return items;
}

function reportTotalsRow(report: GAReport): KeyValueRow | null {
  if (!report.totals || !report.totals[0]) return null;
  return {
    key: 'totals',
    value: report.totals[0]
      .map(
        (v, i) =>
          `${report.metricHeaders[i]?.name ?? '?'}=${formatMetric(v, report.metricHeaders[i]?.type)}`,
      )
      .join('  '),
  };
}

const reportTile = (
  <IconTile accent={GA_BRAND.orange} icon={<BarChart3 size={14} color={GA_BRAND.orange} />} size={26} />
);

const realtimeTile = (
  <IconTile accent={globalColors.green} icon={<Radio size={14} color={globalColors.green} />} size={26} />
);

// ============================================================================
// Run Report
// ============================================================================

export function RunReportRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const report: GAReport | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'rows' in (raw as object)
      ? (raw as GAReport)
      : null;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={report ? `Report · ${report.rowCount ?? report.rows?.length ?? 0} rows` : undefined}
      defaultExpanded={status === 'completed' && !!report?.rows?.length}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && report && (
        <ResourceCard
          leading={reportTile}
          title="Analytics report"
          subtitle={report.propertyId ? `properties/${report.propertyId}` : undefined}
        >
          <MetaStrip items={reportMetaItems(report)} />
          {reportTotalsRow(report) && <KeyValueGrid rows={[reportTotalsRow(report) as KeyValueRow]} />}
          <ReportTable report={report} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Batch Run Reports
// ============================================================================

interface BatchReportsOutput {
  account?: string;
  propertyId?: string;
  count: number;
  reports: GAReport[];
}

export function BatchRunReportsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: BatchReportsOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as BatchReportsOutput) : null;
  const reports = parsed?.reports ?? [];

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={reports.length > 0 ? `${reports.length} reports` : undefined}
      defaultExpanded={status === 'completed' && reports.length > 0}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && reports.length === 0 && <Empty message="No reports" />}
      {!error && reports.length > 0 && (
        <YStack gap={8}>
          {reports.map((r: GAReport, i: number) => (
            <ResourceCard
              // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list
              key={i}
              leading={reportTile}
              title={`Report ${i + 1}`}
              subtitle={`${r.rowCount ?? r.rows?.length ?? 0} rows`}
            >
              <ReportTable report={r} />
            </ResourceCard>
          ))}
        </YStack>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Run Realtime Report
// ============================================================================

export function RunRealtimeReportRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const report: GAReport | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'rows' in (raw as object)
      ? (raw as GAReport)
      : null;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={
        report ? `Realtime · ${report.rowCount ?? report.rows?.length ?? 0} rows` : undefined
      }
      defaultExpanded={status === 'completed' && !!report?.rows?.length}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && report && (
        <ResourceCard
          leading={realtimeTile}
          title="Last 30 minutes"
          subtitle={report.propertyId ? `properties/${report.propertyId}` : undefined}
          meta={<IconChip text="LIVE" accent={globalColors.green} />}
        >
          <MetaStrip items={reportMetaItems(report)} />
          {reportTotalsRow(report) && <KeyValueGrid rows={[reportTotalsRow(report) as KeyValueRow]} />}
          <ReportTable report={report} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Get Metadata (custom dims/metrics for a property)
// ============================================================================

interface MetadataItem {
  apiName: string;
  uiName: string;
  description?: string;
  type?: string;
  category?: string;
  customDefinition?: boolean;
}

interface MetadataOutput {
  account?: string;
  propertyId?: string;
  dimensionsCount: number;
  metricsCount: number;
  dimensions: MetadataItem[];
  metrics: MetadataItem[];
}

const metadataTile = (
  <IconTile accent={GA_BRAND.amber} icon={<Database size={14} color={GA_BRAND.amber} />} size={26} />
);

function MetadataList({ items, label }: { items: MetadataItem[]; label: string }) {
  const c = useColors();
  const scrollStyle = useScrollStyle(220);
  if (items.length === 0) return null;
  const customCount = items.filter((i) => i.customDefinition).length;
  return (
    <YStack gap={4}>
      <XStack gap={6} alignItems="center">
        <Text color={c.text2} fontSize={10} fontWeight="600">
          {label} ({items.length})
        </Text>
        {customCount > 0 && <IconChip text={`${customCount} custom`} accent={GA_BRAND.orange} />}
      </XStack>
      <ScrollView style={scrollStyle}>
        <YStack>
          {items.map((it) => (
            <XStack
              key={it.apiName}
              gap={8}
              paddingVertical={3}
              borderBottomWidth={1}
              borderBottomColor={c.border}
              alignItems="center"
            >
              <Text
                color={it.customDefinition ? GA_BRAND.amber : c.text2}
                fontSize={10}
                fontFamily="$mono"
                minWidth={140}
              >
                {it.apiName}
              </Text>
              <Text flex={1} color={c.text3} fontSize={9} numberOfLines={1}>
                {it.uiName}
              </Text>
              {it.type && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  {it.type.replace(/^TYPE_/, '').toLowerCase()}
                </Text>
              )}
            </XStack>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  );
}

export function GetMetadataRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: MetadataOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as MetadataOutput) : null;

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={
        parsed
          ? `${parsed.dimensionsCount} dimensions · ${parsed.metricsCount} metrics`
          : undefined
      }
      defaultExpanded={status === 'completed' && !!parsed}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={metadataTile}
          title="Property metadata"
          subtitle={parsed.propertyId ? `properties/${parsed.propertyId}` : undefined}
        >
          <MetadataList items={parsed.dimensions} label="Dimensions" />
          <MetadataList items={parsed.metrics} label="Metrics" />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}
