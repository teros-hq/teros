/**
 * Notion Renderer - Database Operations
 *
 * Handles: query-database, get-database, create-database, update-database-schema
 */

import { ExternalLink } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, Empty, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useNotionColors,
  extractPlainText,
  FilterBlock,
  formatDate,
  getDateFromProperties,
  getPageIcon,
  getPageTitle,
  getStatusFromProperties,
  type NotionDatabase,
  type NotionPage,
  PageStatusBadge,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface PageListBlockProps {
  pages: NotionPage[];
}

function PageListBlock({ pages }: PageListBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {pages.map((page) => {
          const title = getPageTitle(page);
          const icon = getPageIcon(page);

          // Shape-agnostic: handles curated (flat values) and legacy (raw Notion objects).
          const status = getStatusFromProperties(page.properties);
          const propertyDate = getDateFromProperties(page.properties);
          const dateStr = propertyDate
            ? formatDate(propertyDate)
            : page.lastEditedTime
              ? formatDate(page.lastEditedTime)
              : undefined;

          return (
            <XStack
              key={page.id}
              alignItems="center"
              gap={10}
              paddingVertical={6}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={c.border}
              hoverStyle={{ backgroundColor: c.bgCardHover }}
              cursor="pointer"
              onPress={() => page.url && Linking.openURL(page.url)}
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
              {status && <PageStatusBadge status={status} />}
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

interface DatabaseDetailBlockProps {
  database: NotionDatabase;
  variant?: 'created' | 'default';
}

function DatabaseDetailBlock({ database, variant = 'default' }: DatabaseDetailBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  const bgColors = {
    created: 'rgba(34,197,94,0.1)',
    default: c.bgInner,
  };

  const icon = getPageIcon(database);

  // Schema: prefer the curated `schema` field (TER-272); fall back to the
  // raw `properties` field for back-compat.
  const schema = database.schema ?? database.properties;
  const schemaNames = schema ? Object.keys(schema) : [];

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
        <Text fontSize={16}>{icon}</Text>
        <Text flex={1} color={c.text} fontSize={12} fontWeight="500" numberOfLines={1}>
          {getPageTitle(database) || 'Untitled Database'}
        </Text>
        {database.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(database.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={c.text2} />
          </XStack>
        )}
      </XStack>

      {/* Description */}
      {database.description && (
        <Text color={c.text2} fontSize={10} numberOfLines={2}>
          {extractPlainText(database.description)}
        </Text>
      )}

      {/* Schema summary (property names) */}
      {schemaNames.length > 0 && (
        <XStack gap={4} flexWrap="wrap">
          {schemaNames.slice(0, 6).map((propName, idx) => (
            <XStack
              key={idx}
              backgroundColor={c.badges.gray.bg}
              paddingHorizontal={5}
              paddingVertical={1}
              borderRadius={3}
            >
              <Text fontSize={8} color={c.badges.gray.text}>
                {propName}
              </Text>
            </XStack>
          ))}
          {schemaNames.length > 6 && (
            <Text fontSize={8} color={c.text3}>
              +{schemaNames.length - 6} more
            </Text>
          )}
        </XStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function QueryDatabaseRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output
    ? parseOutput<{ results?: NotionPage[]; pages?: NotionPage[] } | NotionPage[]>(output)
    : null;

  // Handle various response formats
  let pages: NotionPage[] | null = null;
  if (parsed && typeof parsed === 'object') {
    if ('results' in parsed && Array.isArray(parsed.results)) {
      pages = parsed.results;
    } else if ('pages' in parsed && Array.isArray(parsed.pages)) {
      pages = parsed.pages;
    } else if (Array.isArray(parsed)) {
      pages = parsed;
    }
  }

  const hasPages = pages && pages.length > 0;

  // Build description
  let description = 'Query database';
  if (input?.databaseId) {
    // Try to show a friendly name if we have results with a parent
    description = `Query database`;
  }

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    const count = pages?.length ?? 0;
    badge = (
      <Badge text={formatCountBadge(count, 'page')} variant={countBadgeVariant(count)} />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {/* Filter info */}
        <FilterBlock filter={input?.filter} sorts={input?.sorts} />
        
        {/* Results */}
        {hasPages && <PageListBlock pages={pages!} />}
        {status === 'completed' && pages?.length === 0 && (
          <Empty message="No pages" hint="Try a different filter" />
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetDatabaseRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionDatabase>(output) : null;
  const isDatabase = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = input?.databaseId 
    ? `Get database` 
    : 'Get database';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDatabase) {
    const db = parsed as NotionDatabase;
    badge = <Badge text={truncate(extractPlainText(db.title) || 'Untitled', 20)} variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateDatabaseRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionDatabase | string>(output) : null;
  const isDatabase = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = input?.title 
    ? `Create: ${truncate(input.title, 30)}` 
    : 'Create database';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} variant="created" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdateDatabaseSchemaRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionDatabase | string>(output) : null;
  const isDatabase = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Update database schema';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
