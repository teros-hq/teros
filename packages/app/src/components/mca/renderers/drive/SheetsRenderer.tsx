/**
 * Google Drive - Sheets Renderers
 *
 * Renderers for Google Sheets operations:
 * - read-sheet-range
 * - list-sheet-tabs
 * - export-sheet
 */

import { Download, FileSpreadsheet, Table } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Read Sheet Range Renderer
// ============================================================================

interface SheetRangeResult {
  range: string;
  majorDimension?: string;
  values: string[][];
}

export function ReadSheetRangeRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<SheetRangeResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.values ? parsed : null;
  const rowCount = result?.values?.length || 0;

  // Get range from input
  const inputParsed = typeof input === 'string' ? parseOutput<{ range?: string }>(input) : input;
  const range = inputParsed?.range || result?.range || '';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text={`${rowCount} rows`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Read sheet range'
      : range
        ? `Read range: ${truncate(range, 20)}`
        : 'Read sheet range';

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && result.values.length > 0 && (
          <YStack gap={4}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <YStack gap={1}>
                {result.values.slice(0, 10).map((row, rowIndex) => (
                  <XStack key={rowIndex} gap={1}>
                    {row.slice(0, 6).map((cell, cellIndex) => (
                      <XStack
                        key={cellIndex}
                        backgroundColor={rowIndex === 0 ? 'rgba(66,133,244,0.15)' : colors.bgInner}
                        paddingVertical={4}
                        paddingHorizontal={6}
                        minWidth={60}
                        maxWidth={120}
                        borderRadius={2}
                      >
                        <Text
                          color={rowIndex === 0 ? colors.driveBlue : colors.primary}
                          fontSize={9}
                          fontWeight={rowIndex === 0 ? '600' : '400'}
                          numberOfLines={1}
                        >
                          {truncate(cell || '', 15)}
                        </Text>
                      </XStack>
                    ))}
                    {row.length > 6 && (
                      <XStack
                        backgroundColor={colors.bgInner}
                        paddingVertical={4}
                        paddingHorizontal={6}
                        borderRadius={2}
                      >
                        <Text color={colors.muted} fontSize={9}>
                          +{row.length - 6}
                        </Text>
                      </XStack>
                    )}
                  </XStack>
                ))}
                {result.values.length > 10 && (
                  <Text color={colors.muted} fontSize={9} paddingTop={4}>
                    +{result.values.length - 10} more rows
                  </Text>
                )}
              </YStack>
            </ScrollView>
          </YStack>
        )}

        {status === 'completed' && result && result.values.length === 0 && (
          <Text color={colors.muted} fontSize={10}>
            No data in range
          </Text>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// List Sheet Tabs Renderer
// ============================================================================

interface SheetTab {
  title: string;
  index: number;
  sheetId: number;
  rowCount: number;
  columnCount: number;
}

interface ListTabsResult {
  spreadsheetTitle: string;
  sheets: SheetTab[];
}

export function ListSheetTabsRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<ListTabsResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.sheets ? parsed : null;
  const tabCount = result?.sheets?.length || 0;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text={`${tabCount} tab${tabCount !== 1 ? 's' : ''}`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'List sheet tabs'
      : result?.spreadsheetTitle
        ? `Tabs: ${truncate(result.spreadsheetTitle, 20)}`
        : 'List sheet tabs';

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            {result.spreadsheetTitle && (
              <XStack gap={8} alignItems="center" paddingBottom={4}>
                <FileSpreadsheet size={12} color={colors.spreadsheet} />
                <Text color={colors.primary} fontSize={10} fontWeight="500">
                  {result.spreadsheetTitle}
                </Text>
              </XStack>
            )}

            {result.sheets.map((sheet, idx) => (
              <XStack
                key={sheet.sheetId}
                alignItems="center"
                gap={8}
                paddingVertical={4}
                paddingHorizontal={8}
                backgroundColor={colors.bgInner}
                borderRadius={4}
              >
                <Table size={10} color={colors.spreadsheet} />
                <Text color={colors.primary} fontSize={10} flex={1}>
                  {sheet.title}
                </Text>
                <Text color={colors.muted} fontSize={9}>
                  {sheet.rowCount}×{sheet.columnCount}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Export Sheet Renderer
// ============================================================================

interface ExportResult {
  success: boolean;
  path: string;
  filename: string;
  format: string;
  mimeType: string;
  spreadsheetTitle: string;
}

export function ExportSheetRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<ExportResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.success ? parsed : null;

  // Get format from input
  const inputParsed = typeof input === 'string' ? parseOutput<{ format?: string }>(input) : input;
  const format = inputParsed?.format || result?.format || 'csv';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text={format.toUpperCase()} variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Export sheet (${format})`
      : result?.filename
        ? `Export: ${truncate(result.filename, 20)}`
        : 'Export sheet';

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <SuccessBlock message={`Exported: ${result.filename}`} />

            <YStack gap={4} paddingLeft={8}>
              <XStack gap={8}>
                <Text color={colors.muted} fontSize={9} width={50}>
                  Path:
                </Text>
                <Text
                  color={colors.secondary}
                  fontSize={9}
                  fontFamily="$mono"
                  flex={1}
                  numberOfLines={1}
                >
                  {result.path}
                </Text>
              </XStack>
              <XStack gap={8}>
                <Text color={colors.muted} fontSize={9} width={50}>
                  Format:
                </Text>
                <Text color={colors.secondary} fontSize={9}>
                  {result.format.toUpperCase()}
                </Text>
              </XStack>
            </YStack>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
