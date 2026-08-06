/**
 * Scheduler — parse-time-expression renderer.
 *
 * Read-only preview tool. Output is { kind: 'natural' | 'iso' | 'cron', ... }.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import {
  colors as globalColors,
  ErrorBlock,
  IconChip,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  PillList,
  ResourceCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  calendarIcon,
  type ParseResultShape,
  SchedulerToolShell,
  STATUS_ACCENT,
} from './shared';

function naturalRows(p: Extract<ParseResultShape, { kind: 'natural' }>): KeyValueRow[] {
  return [
    { key: 'expression', value: p.expression },
    { key: 'parsed', value: p.parsed.iso },
    { key: 'humanReadable', value: p.parsed.humanReadable },
    { key: 'timezone', value: p.timezone },
    { key: 'locale', value: p.locale },
    { key: 'confidence', value: p.confidence },
    { key: 'detected', value: p.detectedText },
  ];
}

function isoRows(p: Extract<ParseResultShape, { kind: 'iso' }>): KeyValueRow[] {
  return [
    { key: 'expression', value: p.expression },
    { key: 'parsed', value: p.parsed.iso },
    { key: 'humanReadable', value: p.parsed.humanReadable },
    { key: 'timezone', value: p.timezone },
    { key: 'confidence', value: p.confidence },
  ];
}

function cronRows(p: Extract<ParseResultShape, { kind: 'cron' }>): KeyValueRow[] {
  return [
    { key: 'expression', value: p.expression },
    { key: 'description', value: p.description },
    { key: 'timezone', value: p.timezone },
  ];
}

function titleFor(kind: ParseResultShape['kind']): string {
  if (kind === 'cron') return 'Cron expression';
  if (kind === 'iso') return 'ISO 8601 timestamp';
  return 'Natural-language time';
}

function metaChip(result: ParseResultShape): React.ReactNode {
  if (result.kind === 'cron') {
    return <IconChip text="CRON" accent={STATUS_ACCENT.enabled} />;
  }
  if (result.kind === 'iso') {
    return <IconChip text="ISO 8601" accent={STATUS_ACCENT.success} />;
  }
  // natural
  return (
    <IconChip
      text={`NATURAL · ${(result.locale ?? 'en').toUpperCase()}`}
      accent={STATUS_ACCENT.pending}
    />
  );
}

function rowsFor(result: ParseResultShape): KeyValueRow[] {
  if (result.kind === 'cron') return cronRows(result);
  if (result.kind === 'iso') return isoRows(result);
  return naturalRows(result);
}

export function ParseTimeRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<ParseResultShape>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'kind' in (parsed as object)
      ? (parsed as ParseResultShape)
      : null;

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && result && (
        <ResourceCard title={titleFor(result.kind)} subtitle={result.expression} meta={metaChip(result)}>
          <KeyValueGrid rows={rowsFor(result)} />
          {result.kind === 'cron' && result.nextOccurrences.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                next {result.nextOccurrences.length} occurrences
              </Text>
              <PillList
                items={result.nextOccurrences.map((occ) => occ.humanReadable)}
                accent={STATUS_ACCENT.enabled}
                max={8}
              />
            </YStack>
          )}
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}
