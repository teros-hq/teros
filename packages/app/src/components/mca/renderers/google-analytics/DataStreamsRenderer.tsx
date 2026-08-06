/**
 * GA4 Renderer — Data streams. list, get, create.
 */

import { Globe, Smartphone } from '@tamagui/lucide-icons';
import { ScrollView, Text, YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GA_BRAND,
  type GAStream,
  formatDate,
  GoogleAnalyticsToolShell,
  useScrollStyle,
  STREAM_TYPE_COLORS,
  streamTypeChipProps,
} from './shared';

// ============================================================================
// Helpers
// ============================================================================

function streamRows(s: GAStream): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (s.streamId) rows.push({ key: 'id', value: s.streamId });
  if (s.webStreamData?.measurementId) {
    rows.push({ key: 'measurementId', value: s.webStreamData.measurementId });
  }
  if (s.webStreamData?.defaultUri) {
    rows.push({ key: 'uri', value: s.webStreamData.defaultUri });
  }
  if (s.androidAppStreamData?.packageName) {
    rows.push({ key: 'package', value: s.androidAppStreamData.packageName });
  }
  if (s.iosAppStreamData?.bundleId) {
    rows.push({ key: 'bundle', value: s.iosAppStreamData.bundleId });
  }
  if (s.webStreamData?.firebaseAppId || s.androidAppStreamData?.firebaseAppId || s.iosAppStreamData?.firebaseAppId) {
    rows.push({
      key: 'firebase',
      value:
        s.webStreamData?.firebaseAppId ??
        s.androidAppStreamData?.firebaseAppId ??
        s.iosAppStreamData?.firebaseAppId ??
        '—',
    });
  }
  if (s.createTime) rows.push({ key: 'created', value: formatDate(s.createTime) });
  if (s.updateTime) rows.push({ key: 'updated', value: formatDate(s.updateTime) });
  return rows;
}

function streamTile(type?: string) {
  const accent = type ? STREAM_TYPE_COLORS[type] ?? GA_BRAND.orange : GA_BRAND.orange;
  const isApp = type === 'ANDROID_APP_DATA_STREAM' || type === 'IOS_APP_DATA_STREAM';
  return (
    <IconTile
      accent={accent}
      icon={isApp ? <Smartphone size={14} color={accent} /> : <Globe size={14} color={accent} />}
      size={26}
    />
  );
}

function streamSubtitle(s: GAStream): string | undefined {
  if (s.webStreamData?.measurementId) return s.webStreamData.measurementId;
  if (s.androidAppStreamData?.packageName) return s.androidAppStreamData.packageName;
  if (s.iosAppStreamData?.bundleId) return s.iosAppStreamData.bundleId;
  return s.streamId ? `streams/${s.streamId}` : undefined;
}

/**
 * Data stream detail as 2-section `Specsheet` — stream identity + platform-
 * specific SDK identifiers. The SDK section only shows the fields relevant
 * to the stream's platform (web → measurementId/uri; android → package;
 * ios → bundle), avoiding the mix-and-match KeyValueGrid that obscured
 * which identifier belonged to which platform.
 */
function streamSections(s: GAStream): SpecsheetSection[] {
  const out: SpecsheetSection[] = [];
  const stream: SpecsheetSection['rows'] = [];
  if (s.streamId) stream.push({ key: 'streamId', value: s.streamId });
  if (s.displayName) stream.push({ key: 'displayName', value: s.displayName });
  if (s.type) stream.push({ key: 'type', value: s.type.replace(/_DATA_STREAM$/, '').toLowerCase() });
  if (s.createTime) stream.push({ key: 'created', value: formatDate(s.createTime) });
  if (s.updateTime) stream.push({ key: 'updated', value: formatDate(s.updateTime) });
  out.push({ title: 'Stream', rows: stream });

  const sdk: SpecsheetSection['rows'] = [];
  if (s.webStreamData?.measurementId) {
    sdk.push({ key: 'measurementId', value: s.webStreamData.measurementId });
  }
  if (s.webStreamData?.defaultUri) {
    sdk.push({ key: 'uri', value: s.webStreamData.defaultUri });
  }
  if (s.androidAppStreamData?.packageName) {
    sdk.push({ key: 'package', value: s.androidAppStreamData.packageName });
  }
  if (s.iosAppStreamData?.bundleId) {
    sdk.push({ key: 'bundle', value: s.iosAppStreamData.bundleId });
  }
  const firebaseId =
    s.webStreamData?.firebaseAppId ??
    s.androidAppStreamData?.firebaseAppId ??
    s.iosAppStreamData?.firebaseAppId;
  if (firebaseId) sdk.push({ key: 'firebase', value: firebaseId });
  if (sdk.length > 0) out.push({ title: 'SDK', rows: sdk });

  return out;
}

// ============================================================================
// List Data Streams
// ============================================================================

interface ListStreamsOutput {
  account?: string;
  count: number;
  streams: GAStream[];
  nextPageToken?: string;
}

export function ListDataStreamsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useColors();
  const raw = output ? parseOutput(output) : null;
  const parsed: ListStreamsOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ListStreamsOutput) : null;
  const streams = parsed?.streams ?? [];
  const scrollStyle = useScrollStyle(360);

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={streams.length > 0 ? `${streams.length} streams` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && streams.length === 0 && <Empty message="No data streams" />}
      {!error && streams.length > 0 && (
        <ScrollView style={scrollStyle}>
          <YStack>
            {streams.map((s: GAStream) => {
              const typeChip = streamTypeChipProps(s.type);
              return (
                <EntityRow
                  key={s.streamId ?? s.name}
                  leading={streamTile(s.type)}
                  title={s.displayName ?? s.name ?? '—'}
                  subtitle={streamSubtitle(s)}
                  badges={typeChip && <IconChip text={typeChip.text} accent={typeChip.accent} />}
                  meta={
                    <Text color={c.text3} fontSize={9}>
                      {formatDate(s.createTime)}
                    </Text>
                  }
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

// ============================================================================
// Get Data Stream (detail)
// ============================================================================

interface GetStreamOutput {
  account?: string;
  stream: GAStream;
}

export function GetDataStreamRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: GetStreamOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GetStreamOutput) : null;
  const s = parsed?.stream;
  const typeChip = streamTypeChipProps(s?.type);

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={s?.displayName}
      defaultExpanded={status === 'completed' && !!s}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && s && (
        <ResourceCard
          leading={streamTile(s.type)}
          title={s.displayName ?? '—'}
          subtitle={streamSubtitle(s)}
          meta={typeChip && <IconChip text={typeChip.text} accent={typeChip.accent} />}
        >
          <Specsheet sections={streamSections(s)} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}

// ============================================================================
// Create Data Stream
// ============================================================================

export function CreateDataStreamRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput(output) : null;
  const parsed: GetStreamOutput | null =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GetStreamOutput) : null;
  const s = parsed?.stream;
  const typeChip = streamTypeChipProps(s?.type);

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description={s?.displayName ? `Created: ${s.displayName}` : undefined}
      defaultExpanded={status === 'completed' && !!s}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && s && (
        <ResourceCard
          leading={streamTile(s.type)}
          title={s.displayName ?? '—'}
          subtitle={streamSubtitle(s)}
          verb="created"
          meta={typeChip && <IconChip text={typeChip.text} accent={typeChip.accent} />}
        >
          <KeyValueGrid rows={streamRows(s)} />
        </ResourceCard>
      )}
    </GoogleAnalyticsToolShell>
  );
}
