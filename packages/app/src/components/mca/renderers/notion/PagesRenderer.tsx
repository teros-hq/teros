/**
 * Notion Renderer - Page Operations
 *
 * Handles: search, get-page, get-page-markdown, create-page, update-page,
 * update-page-markdown, create-database-item, update-database-item,
 * duplicate-page, set-page-icon, set-page-cover.
 *
 * `get-page-markdown` (v5 native) replaces the old `get-page-content` that
 * relied on a backend block-walk + `marked` parsing on the frontend.
 */

import { ExternalLink, FileText, Database } from '@tamagui/lucide-icons';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, ScrollView, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';
import { Text, XStack, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  countBadgeVariant,
  Empty,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  formatCountBadge,
  formatDate,
  formatPropertyPreview,
  getPageIcon,
  getPageTitle,
  HeaderRow,
  type NotionPage,
  type NotionDatabase,
  parseOutput,
  SuccessBlock,
  ToolCallCard,
  truncate,
  useNotionColors,
  WarningBlock,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface SearchResultsBlockProps {
  results: Array<NotionPage | NotionDatabase>;
}

function SearchResultsBlock({ results }: SearchResultsBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {results.map((item: any) => {
          const isDatabase = item.object === 'database';
          const title = getPageTitle(item) || (isDatabase ? 'Untitled Database' : 'Untitled');
          const icon = isDatabase ? getPageIcon(item) || '🗃️' : getPageIcon(item);
          // Curated shape uses camelCase `lastEditedTime`; legacy uses snake_case.
          const dateStr = formatDate(item.lastEditedTime ?? item.last_edited_time);

          return (
            <XStack
              key={item.id}
              alignItems="center"
              gap={10}
              paddingVertical={6}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={c.border}
              hoverStyle={{ backgroundColor: c.bgCardHover }}
              cursor="pointer"
              onPress={() => item.url && Linking.openURL(item.url)}
            >
              <Text fontSize={13} width={18} textAlign="center">
                {icon}
              </Text>
              <Text
                flex={1}
                color={c.text}
                fontSize={11}
                numberOfLines={1}
              >
                {title}
              </Text>
              <XStack
                backgroundColor={isDatabase ? c.badges.info.bg : c.badges.gray.bg}
                paddingHorizontal={5}
                paddingVertical={1}
                borderRadius={3}
                alignItems="center"
                gap={3}
              >
                {isDatabase ? (
                  <Database size={8} color={c.badges.info.text} />
                ) : (
                  <FileText size={8} color={c.badges.gray.text} />
                )}
                <Text 
                  fontSize={8} 
                  color={isDatabase ? c.badges.info.text : c.badges.gray.text}
                >
                  {isDatabase ? 'database' : 'page'}
                </Text>
              </XStack>
              {dateStr && (
                <Text fontSize={9} fontFamily="$mono" color={c.text3}>
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
  const c = useNotionColors();
  const colors = useNotionColors();
  const bgColors = {
    created: 'rgba(34,197,94,0.1)',
    updated: 'rgba(59,130,246,0.1)',
    default: c.bgInner,
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
        <Text flex={1} color={c.text} fontSize={12} fontWeight="500" numberOfLines={2}>
          {title}
        </Text>
        {page.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(page.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={c.text2} />
          </XStack>
        )}
      </XStack>

      {/* Properties preview */}
      {page.properties && Object.keys(page.properties).length > 0 && (
        <XStack gap={4} flexWrap="wrap">
          {Object.entries(page.properties)
            .slice(0, 4)
            .map(([key, value]: [string, any], idx) => {
              // Hide title (already shown in the header) and pure empty values.
              if (value?.type === 'title') return null;
              const displayValue = formatPropertyPreview(value);
              if (!displayValue) return null;
              return (
                <XStack
                  key={idx}
                  backgroundColor={c.badges.gray.bg}
                  paddingHorizontal={5}
                  paddingVertical={2}
                  borderRadius={3}
                  gap={4}
                >
                  <Text fontSize={8} color={c.text3}>
                    {key}:
                  </Text>
                  <Text fontSize={8} color={c.badges.gray.text}>
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
          <Text fontSize={9} color={c.text3}>
            Created {formatDate(page.createdTime)}
          </Text>
        )}
        {page.lastEditedTime && (
          <Text fontSize={9} color={c.text3}>
            Edited {formatDate(page.lastEditedTime)}
          </Text>
        )}
      </XStack>
    </YStack>
  );
}


interface PageContentBlockProps {
  content: string;
}

/**
 * Renders a page body as markdown. Uses the global `<MarkdownContent>` from
 * `chat/bubbles/MarkdownContent.tsx` per CLAUDE.md so the look matches
 * regular agent messages and we don't ship `marked` + `react-native-render-html`
 * just for this MCA.
 */
function PageContentBlock({ content }: PageContentBlockProps) {
  const c = useNotionColors();
  const displayContent =
    content.length > 4000
      ? `${content.slice(0, 4000)}\n\n*… (content truncated)*`
      : content;

  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator
    >
      <YStack padding={10}>
        <MarkdownContent text={displayContent} />
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
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

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
  if (status === 'completed') {
    const count = results?.length ?? 0;
    badge = (
      <Badge text={formatCountBadge(count, 'result')} variant={countBadgeVariant(count)} />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
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
            <Text fontSize={9} color={c.text3} textTransform="uppercase" letterSpacing={0.5}>
              Type
            </Text>
            <XStack
              backgroundColor={c.badges.info.bg}
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={3}
            >
              <Text fontSize={9} color={c.badges.info.text}>
                {input.filter}
              </Text>
            </XStack>
          </XStack>
        )}
        
        {/* Results */}
        {hasResults && <SearchResultsBlock results={results!} />}
        {status === 'completed' && results?.length === 0 && (
          <Empty
            message={`No results for "${input?.query ?? ''}"`}
            hint="Try a different query"
          />
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetPageRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

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



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isPage && <PageDetailBlock page={parsed as NotionPage} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetPageMarkdownRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Parse output and extract textContent
  // Handle truncated output (system truncates at 30k chars, breaking JSON)
  let content: string | null = null;
  let parseError: string | null = null;
  let isTruncated = false;

  if (output && status === 'completed') {
    const truncationMarker = '[... OUTPUT TRUNCATED BY SYSTEM:';
    isTruncated = output.includes(truncationMarker);

    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && typeof parsed.markdown === 'string') {
        content = parsed.markdown;
      } else {
        parseError = `Expected { markdown: string }, got: ${JSON.stringify(Object.keys(parsed || {}))}`;
      }
    } catch (e) {
      if (isTruncated) {
        const m = output.match(/"markdown"\s*:\s*"([\s\S]*)/);
        if (m) {
          let extracted = m[1];
          const idx = extracted.indexOf(truncationMarker);
          if (idx !== -1) extracted = extracted.slice(0, idx);
          extracted = extracted.replace(/\\?$/, '').replace(/"?\s*,?\s*$/, '');
          content = extracted;
          parseError = t('errors.notion.contentTruncated');
        } else {
          parseError = t('errors.notion.outputTruncated');
        }
      } else {
        parseError = t('errors.notion.parseFailed', { error: e instanceof Error ? e.message : t('errors.unknownError') });
      }
    }
  }

  const description = input?.includeTranscript ? 'Get page (with transcript)' : 'Get page markdown';

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



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {content && <PageContentBlock content={content} />}
        {parseError && !content && <ErrorBlock error={parseError} />}
        {parseError && content && <WarningBlock message={parseError} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdatePageMarkdownRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = output
    ? parseOutput<{ pageId?: string; blocksReplaced?: number | null }>(output)
    : null;
  const blocksReplaced =
    parsed && typeof parsed === 'object' && 'blocksReplaced' in parsed
      ? (parsed.blocksReplaced ?? null)
      : null;

  const previewSource =
    typeof input?.markdown === 'string' ? input.markdown.slice(0, 4000) : null;

  const description = 'Update page (markdown)';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={blocksReplaced != null ? `${blocksReplaced} blocks` : 'replaced'} variant="info" />;
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
        {previewSource && <PageContentBlock content={previewSource} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreatePageRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

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



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isPage && <PageDetailBlock page={parsed as NotionPage} variant="created" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdatePageRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionPage | string>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Update page';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isPage && <PageDetailBlock page={parsed as NotionPage} variant="updated" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DuplicatePageRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

  // New shape (TER-272): { sourcePage, duplicate, blocksCopied }.
  // Legacy shape: { success, originalPageId, newPageId, newPage } or just a page.
  const parsed = output
    ? parseOutput<
        | { sourcePage?: NotionPage; duplicate?: NotionPage; blocksCopied?: number }
        | { newPage?: NotionPage }
        | NotionPage
        | string
      >(output)
    : null;

  const { sourcePage, duplicate, blocksCopied } = (() => {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as any;
      if (p.duplicate && typeof p.duplicate === 'object') {
        return {
          sourcePage: p.sourcePage as NotionPage | undefined,
          duplicate: p.duplicate as NotionPage,
          blocksCopied: typeof p.blocksCopied === 'number' ? p.blocksCopied : undefined,
        };
      }
      if (p.newPage && typeof p.newPage === 'object') {
        return {
          sourcePage: undefined,
          duplicate: p.newPage as NotionPage,
          blocksCopied: undefined,
        };
      }
      if (p.id) {
        return { sourcePage: undefined, duplicate: p as NotionPage, blocksCopied: undefined };
      }
    }
    return { sourcePage: undefined, duplicate: undefined, blocksCopied: undefined };
  })();

  const description = input?.newTitle
    ? `Duplicate: ${truncate(input.newTitle, 25)}`
    : 'Duplicate page';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="duplicated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {sourcePage && <PageDetailBlock page={sourcePage} />}
        {duplicate && <PageDetailBlock page={duplicate} variant="created" />}
        {blocksCopied !== undefined && (
          <Text color={c.text3} fontSize={9} fontFamily="$mono">
            {blocksCopied} block{blocksCopied === 1 ? '' : 's'} copied
          </Text>
        )}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function SetPageIconRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const iconPreview = input?.iconType === 'emoji' && input?.icon ? input.icon : '🎨';
  const description = `Set icon ${iconPreview}`;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message={`Page icon set to ${iconPreview}`} />
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateDatabaseItemRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  // Surface the simple shape preview when the page response is missing
  // (failure paths). Helps the user see what the agent tried to insert.
  const simpleProps =
    input?.properties && typeof input.properties === 'object'
      ? Object.entries(input.properties).slice(0, 4)
      : [];

  const description = 'Insert row';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="inserted" variant="success" />;
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
        {!isPage && simpleProps.length > 0 && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
            gap={4}
          >
            <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.5}>
              Properties to insert
            </Text>
            {simpleProps.map(([key, value]: [string, any]) => (
              <XStack key={key} gap={4} alignItems="center">
                <Text fontSize={9} color={c.text3}>
                  {key}:
                </Text>
                <Text fontSize={10} color={c.text}>
                  {Array.isArray(value)
                    ? value.join(', ')
                    : typeof value === 'object' && value !== null
                      ? JSON.stringify(value)
                      : String(value)}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function UpdateDatabaseItemRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionPage>(output) : null;
  const isPage = parsed && typeof parsed === 'object' && 'id' in parsed;

  const simpleProps =
    input?.properties && typeof input.properties === 'object'
      ? Object.entries(input.properties).slice(0, 4)
      : [];

  const description = input?.archived === true ? 'Archive row' : 'Update row';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = (
      <Badge
        text={input?.archived === true ? 'archived' : 'updated'}
        variant={input?.archived === true ? 'gray' : 'info'}
      />
    );
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
        {!isPage && simpleProps.length > 0 && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
            gap={4}
          >
            <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.5}>
              Property changes
            </Text>
            {simpleProps.map(([key, value]: [string, any]) => (
              <XStack key={key} gap={4} alignItems="center">
                <Text fontSize={9} color={c.text3}>
                  {key}:
                </Text>
                <Text fontSize={10} color={c.text}>
                  {Array.isArray(value)
                    ? value.join(', ')
                    : typeof value === 'object' && value !== null
                      ? JSON.stringify(value)
                      : String(value)}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function SetPageCoverRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const description = 'Set page cover';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message="Page cover image updated" />
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
