/**
 * Google Drive - Google Docs Renderers
 *
 * Renderers for reading Google Workspace documents:
 * - read-spreadsheet
 * - read-presentation
 * - read-slide
 * - read-document
 */

import {
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Presentation,
  Table,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  getShortToolName,
  HeaderRow,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Read Spreadsheet Renderer
// ============================================================================

interface SpreadsheetResult {
  spreadsheetId?: string;
  range?: string;
  values?: string[][];
  rowCount?: number;
  columnCount?: number;
  error?: string;
}

export function ReadSpreadsheetRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<SpreadsheetResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const hasData = result?.values && result.values.length > 0;

  // Description - get range from input
  const inputParsed = typeof input === 'string' ? parseOutput<{ range?: string }>(input) : input;
  const range = inputParsed?.range || result?.range || '';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && hasData) {
    const rows = result?.values?.length || 0;
    badge = <Badge text={`${rows} rows`} variant="gray" />;
  } else if (status === 'failed' || result?.error) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Read spreadsheet'
      : range
        ? `Read spreadsheet (${range})`
        : 'Read spreadsheet';

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
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || 'Failed to read spreadsheet'} />
        )}

        {status === 'completed' && hasData && result?.values && (
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
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Read Presentation Renderer
// ============================================================================

interface Slide {
  objectId?: string;
  pageElements?: Array<{
    objectId?: string;
    shape?: {
      text?: {
        textElements?: Array<{
          textRun?: {
            content?: string;
          };
        }>;
      };
    };
  }>;
}

interface PresentationResult {
  presentationId?: string;
  title?: string;
  slides?: Slide[];
  slideCount?: number;
  error?: string;
}

export function ReadPresentationRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<PresentationResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const slideCount = result?.slideCount || result?.slides?.length || 0;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && slideCount > 0) {
    badge = <Badge text={`${slideCount} slides`} variant="gray" />;
  } else if (status === 'failed' || result?.error) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Read presentation'
      : result?.title
        ? `Read presentation: ${truncate(result.title, 20)}`
        : 'Read presentation';

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
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || 'Failed to read presentation'} />
        )}

        {status === 'completed' && result && (
          <YStack gap={4}>
            {result.title && (
              <XStack gap={8} alignItems="center">
                <Presentation size={12} color={colors.presentation} />
                <Text color={colors.primary} fontSize={11} fontWeight="500">
                  {result.title}
                </Text>
              </XStack>
            )}
            <Text color={colors.secondary} fontSize={10}>
              {slideCount} slide{slideCount !== 1 ? 's' : ''} in presentation
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Read Document Renderer
// ============================================================================

interface DocumentResult {
  documentId?: string;
  title?: string;
  content?: string;
  body?: {
    content?: Array<{
      paragraph?: {
        elements?: Array<{
          textRun?: {
            content?: string;
          };
        }>;
      };
    }>;
  };
  error?: string;
}

export function ReadDocumentRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<DocumentResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;

  // Extract text content
  let textContent = result?.content || '';
  if (!textContent && result?.body?.content) {
    textContent = result.body.content
      .map(
        (block) => block.paragraph?.elements?.map((el) => el.textRun?.content || '').join('') || '',
      )
      .join('\n')
      .trim();
  }

  const hasContent = textContent.length > 0;
  const wordCount = textContent.split(/\s+/).filter(Boolean).length;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && hasContent) {
    badge = <Badge text={`${wordCount} words`} variant="gray" />;
  } else if (status === 'failed' || result?.error) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Read document'
      : result?.title
        ? `Read document: ${truncate(result.title, 20)}`
        : 'Read document';

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
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || 'Failed to read document'} />
        )}

        {status === 'completed' && result && (
          <YStack gap={4}>
            {result.title && (
              <XStack gap={8} alignItems="center">
                <FileText size={12} color={colors.document} />
                <Text color={colors.primary} fontSize={11} fontWeight="500">
                  {result.title}
                </Text>
              </XStack>
            )}

            {hasContent && (
              <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={8} maxHeight={150}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text color={colors.secondary} fontSize={10} lineHeight={16}>
                    {truncate(textContent, 500)}
                  </Text>
                </ScrollView>
              </YStack>
            )}

            <Text color={colors.muted} fontSize={9}>
              {wordCount} words
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Read Slide Renderer
// ============================================================================

interface SlideResult {
  slideId: string;
  pageNumber: number;
  title: string;
  content: string;
  notes?: string;
  shapes?: Array<{
    type: string;
    text: string;
    isTitle: boolean;
  }>;
}

export function ReadSlideRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<SlideResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.slideId ? parsed : null;

  // Get slide index from input
  const inputParsed =
    typeof input === 'string' ? parseOutput<{ slideIndex?: number }>(input) : input;
  const slideIndex = inputParsed?.slideIndex;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text={`Slide ${result.pageNumber}`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Read slide ${slideIndex !== undefined ? slideIndex + 1 : ''}`
      : result?.title
        ? `Slide: ${truncate(result.title, 25)}`
        : 'Read slide';

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
          <YStack gap={6}>
            <XStack gap={8} alignItems="center">
              <Presentation size={12} color={colors.presentation} />
              <Text color={colors.primary} fontSize={11} fontWeight="500" flex={1}>
                {result.title}
              </Text>
              <Text color={colors.muted} fontSize={9}>
                Page {result.pageNumber}
              </Text>
            </XStack>

            {result.content && (
              <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={8} maxHeight={120}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text color={colors.secondary} fontSize={10} lineHeight={14}>
                    {truncate(result.content, 400)}
                  </Text>
                </ScrollView>
              </YStack>
            )}

            {result.notes && (
              <YStack gap={2}>
                <Text color={colors.muted} fontSize={9}>
                  Speaker notes:
                </Text>
                <Text color={colors.secondary} fontSize={9} fontStyle="italic" numberOfLines={2}>
                  {truncate(result.notes, 150)}
                </Text>
              </YStack>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
