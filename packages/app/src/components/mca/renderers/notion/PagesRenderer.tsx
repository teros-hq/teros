/**
 * Notion Renderer - Page Operations
 *
 * Handles: search, get-page, get-page-content, create-page, update-page, duplicate-page, set-page-icon, set-page-cover
 */

import { ExternalLink, FileText, Database } from '@tamagui/lucide-icons';
import { marked } from 'marked';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Linking, Platform, ScrollView, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  formatDate,
  getPageIcon,
  getPageTitle,
  HeaderRow,
  type NotionPage,
  type NotionDatabase,
  parseOutput,
  SuccessBlock,
  truncate,
  WarningBlock,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface SearchResultsBlockProps {
  results: Array<NotionPage | NotionDatabase>;
}

function SearchResultsBlock({ results }: SearchResultsBlockProps) {
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {results.map((item: any) => {
          const isDatabase = item.object === 'database';
          const title = isDatabase 
            ? (item.title?.[0]?.plain_text || 'Untitled Database')
            : getPageTitle(item);
          const icon = isDatabase
            ? (item.icon?.emoji || '🗃️')
            : getPageIcon(item);
          const dateStr = formatDate(item.last_edited_time);

          return (
            <XStack
              key={item.id}
              alignItems="center"
              gap={10}
              paddingVertical={6}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
              hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.02)' }}
              cursor="pointer"
              onPress={() => item.url && Linking.openURL(item.url)}
            >
              <Text fontSize={13} width={18} textAlign="center">
                {icon}
              </Text>
              <Text
                flex={1}
                color={colors.primary}
                fontSize={11}
                numberOfLines={1}
              >
                {title}
              </Text>
              <XStack
                backgroundColor={isDatabase ? colors.badgeInfo.bg : colors.badgeGray.bg}
                paddingHorizontal={5}
                paddingVertical={1}
                borderRadius={3}
                alignItems="center"
                gap={3}
              >
                {isDatabase ? (
                  <Database size={8} color={colors.badgeInfo.text} />
                ) : (
                  <FileText size={8} color={colors.badgeGray.text} />
                )}
                <Text 
                  fontSize={8} 
                  color={isDatabase ? colors.badgeInfo.text : colors.badgeGray.text}
                >
                  {isDatabase ? 'database' : 'page'}
                </Text>
              </XStack>
              {dateStr && (
                <Text fontSize={9} fontFamily="$mono" color={colors.muted}>
                  {dateStr}
                </Text>
              )}
            </XStack>
          );
        })}
      </YStack>
    </ScrollView>
  );
}

interface PageDetailBlockProps {
  page: NotionPage;
  variant?: 'created' | 'updated' | 'default';
}

function PageDetailBlock({ page, variant = 'default' }: PageDetailBlockProps) {
  const bgColors = {
    created: 'rgba(34,197,94,0.1)',
    updated: 'rgba(59,130,246,0.1)',
    default: colors.bgInner,
  };

  const title = getPageTitle(page);
  const icon = getPageIcon(page);

  return (
    <YStack
      backgroundColor={bgColors[variant]}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      {/* Header with icon and title */}
      <XStack alignItems="center" gap={8}>
        <Text fontSize={18}>{icon}</Text>
        <Text flex={1} color={colors.bright} fontSize={12} fontWeight="500" numberOfLines={2}>
          {title}
        </Text>
        {page.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(page.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={colors.secondary} />
          </XStack>
        )}
      </XStack>

      {/* Properties preview */}
      {page.properties && Object.keys(page.properties).length > 0 && (
        <XStack gap={4} flexWrap="wrap">
          {Object.entries(page.properties).slice(0, 4).map(([key, value]: [string, any], idx) => {
            let displayValue = '';
            if (value?.type === 'status' && value.status?.name) {
              displayValue = value.status.name;
            } else if (value?.type === 'select' && value.select?.name) {
              displayValue = value.select.name;
            } else if (value?.type === 'date' && value.date?.start) {
              displayValue = formatDate(value.date.start);
            } else if (value?.type === 'checkbox') {
              displayValue = value.checkbox ? '✓' : '✗';
            }
            
            if (!displayValue || value?.type === 'title') return null;
            
            return (
              <XStack
                key={idx}
                backgroundColor={colors.badgeGray.bg}
                paddingHorizontal={5}
                paddingVertical={2}
                borderRadius={3}
                gap={4}
              >
                <Text fontSize={8} color={colors.muted}>
                  {key}:
                </Text>
                <Text fontSize={8} color={colors.badgeGray.text}>
                  {displayValue}
                </Text>
              </XStack>
            );
          })}
        </XStack>
      )}

      {/* Timestamps */}
      <XStack gap={12}>
        {page.createdTime && (
          <Text fontSize={9} color={colors.muted}>
            Created {formatDate(page.createdTime)}
          </Text>
        )}
        {page.lastEditedTime && (
          <Text fontSize={9} color={colors.muted}>
            Edited {formatDate(page.lastEditedTime)}
          </Text>
        )}
      </XStack>
    </YStack>
  );
}

// Styles for HTML rendering inside the content block
const contentTagsStyles: Record<string, any> = {
  body: {
    color: '#d4d4d8',
    fontSize: 12,
    lineHeight: 18,
    ...(Platform.OS === 'web' ? { userSelect: 'text', cursor: 'text' } : {}),
  },
  p: {
    marginTop: 0,
    marginBottom: 6,
  },
  strong: {
    fontWeight: '600',
    color: '#e4e4e7',
  },
  em: {
    fontStyle: 'italic',
  },
  code: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  pre: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    padding: 8,
    borderRadius: 4,
    marginVertical: 6,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  ul: {
    marginVertical: 4,
    paddingLeft: 16,
  },
  ol: {
    marginVertical: 4,
    paddingLeft: 16,
  },
  li: {
    marginVertical: 2,
  },
  a: {
    color: '#06B6D4',
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(255, 255, 255, 0.3)',
    marginVertical: 6,
    paddingLeft: 8,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  h1: {
    marginTop: 12,
    marginBottom: 6,
    fontWeight: '600',
    color: '#e4e4e7',
    fontSize: 16,
  },
  h2: {
    marginTop: 10,
    marginBottom: 4,
    fontWeight: '600',
    color: '#e4e4e7',
    fontSize: 14,
  },
  h3: {
    marginTop: 8,
    marginBottom: 4,
    fontWeight: '600',
    color: '#e4e4e7',
    fontSize: 12,
  },
};

interface PageContentBlockProps {
  content: string;
}

function PageContentBlock({ content }: PageContentBlockProps) {
  const { width } = useWindowDimensions();
  
  // Convert markdown to HTML
  const html = useMemo(() => {
    // Truncate very long content before rendering
    const displayContent = content.length > 3000 
      ? content.slice(0, 3000) + '\n\n*... (content truncated)*' 
      : content;
    return marked.parse(displayContent) as string;
  }, [content]);

  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack padding={10}>
        <RenderHtml
          contentWidth={width * 0.8}
          source={{ html }}
          tagsStyles={contentTagsStyles}
          defaultTextProps={{ selectable: true }}
        />
      </YStack>
    </ScrollView>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function SearchRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(true); // Expanded by default for search results
  
  const parsed = output
    ? parseOutput<{ results?: Array<NotionPage | NotionDatabase> }>(output)
    : null;

  const results = parsed && typeof parsed === 'object' && 'results' in parsed
    ? parsed.results
    : null;

  const hasResults = results && results.length > 0;

  let description = 'Search';
  if (input?.query) {
    description = `Search "${truncate(input.query, 25)}"`;
  }

  let badge: React.ReactNode = null;
  if (status === 'completed' && hasResults) {
    badge = <Badge text={`${results!.length} results`} variant="gray" />;
  } else if (status === 'completed' && results?.length === 0) {
    badge = <Badge text="no results" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Filter info */}
        {input?.filter && (
          <XStack
            backgroundColor={colors.bgFilter}
            borderRadius={5}
            paddingVertical={6}
            paddingHorizontal={8}
            alignItems="center"
            gap={8}
          >
            <Text fontSize={9} color={colors.muted} textTransform="uppercase" letterSpacing={0.5}>
              Type
            </Text>
            <XStack
              backgroundColor={colors.badgeInfo.bg}
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={3}
            >
              <Text fontSize={9} color={colors.badgeInfo.text}>
                {input.filter}
              </Text>
            </XStack>
          </XStack>
        )}
        
        {/* Results */}
        {hasResults && <SearchResultsBlock results={results!} />}
        {status === 'completed' && results?.length === 0 && (
          <XStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={colors.muted} fontSize={10}>
              No results found for "{input?.query}"
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetPageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Get page';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isPage) {
    const page = parsed as NotionPage;
    badge = <Badge text={truncate(getPageTitle(page), 20)} variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isPage && <PageDetailBlock page={parsed as NotionPage} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetPageContentRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  
  // Parse output and extract textContent
  // Handle truncated output (system truncates at 30k chars, breaking JSON)
  let content: string | null = null;
  let parseError: string | null = null;
  let isTruncated = false;
  
  if (output && status === 'completed') {
    // Check if output was truncated by the system
    const truncationMarker = '[... OUTPUT TRUNCATED BY SYSTEM:';
    isTruncated = output.includes(truncationMarker);
    
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && typeof parsed.textContent === 'string') {
        content = parsed.textContent;
      } else {
        parseError = `Expected { textContent: string }, got: ${JSON.stringify(Object.keys(parsed || {}))}`;
      }
    } catch (e) {
      // JSON parsing failed - try to extract textContent manually if truncated
      if (isTruncated) {
        // Try to extract content from truncated JSON
        // Format: {"textContent": "...content...
        const textContentMatch = output.match(/"textContent"\s*:\s*"([\s\S]*)/);
        if (textContentMatch) {
          // Extract the content, removing the truncation marker and trailing garbage
          let extracted = textContentMatch[1];
          const truncationIndex = extracted.indexOf(truncationMarker);
          if (truncationIndex !== -1) {
            extracted = extracted.slice(0, truncationIndex);
          }
          // Clean up trailing incomplete escape sequences or quotes
          extracted = extracted.replace(/\\?$/, '').replace(/"?\s*,?\s*"?blocks"?\s*:?\s*\[?[\s\S]*$/, '');
          content = extracted;
          parseError = 'Content was truncated by system (exceeded 30k char limit)';
        } else {
          parseError = `Output truncated and could not extract content`;
        }
      } else {
        parseError = `Failed to parse output: ${e instanceof Error ? e.message : 'Unknown error'}`;
      }
    }
  }

  const description = 'Get page content';

  let badge: React.ReactNode = null;
  if (status === 'completed' && content && !isTruncated) {
    badge = <Badge text="fetched" variant="success" />;
  } else if (status === 'completed' && content && isTruncated) {
    badge = <Badge text="truncated" variant="warning" />;
  } else if (status === 'completed' && parseError && !content) {
    badge = <Badge text="parse error" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {content && <PageContentBlock content={content} />}
        {parseError && !content && <ErrorBlock error={parseError} />}
        {parseError && content && (
          <WarningBlock message={parseError} />
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreatePageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage | string>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = input?.title 
    ? `Create: ${truncate(input.title, 30)}` 
    : 'Create page';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isPage && <PageDetailBlock page={parsed as NotionPage} variant="created" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function UpdatePageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage | string>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Update page';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isPage && <PageDetailBlock page={parsed as NotionPage} variant="updated" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function DuplicatePageRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage | string>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = input?.newTitle 
    ? `Duplicate: ${truncate(input.newTitle, 25)}` 
    : 'Duplicate page';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="duplicated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isPage && <PageDetailBlock page={parsed as NotionPage} variant="created" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function SetPageIconRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const iconPreview = input?.iconType === 'emoji' && input?.icon ? input.icon : '🎨';
  const description = `Set icon ${iconPreview}`;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <SuccessBlock message={`Page icon set to ${iconPreview}`} />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function SetPageCoverRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const description = 'Set page cover';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <SuccessBlock message="Page cover image updated" />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
