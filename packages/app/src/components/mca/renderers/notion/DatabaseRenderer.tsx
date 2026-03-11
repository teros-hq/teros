/**
 * Notion Renderer - Database Operations
 *
 * Handles: query-database, get-database, create-database, update-database-schema
 */

import { ExternalLink } from '@tamagui/lucide-icons';
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
  FilterBlock,
  formatDate,
  getPageIcon,
  getPageTitle,
  HeaderRow,
  type NotionDatabase,
  type NotionPage,
  PageStatusBadge,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface PageListBlockProps {
  pages: NotionPage[];
}

function PageListBlock({ pages }: PageListBlockProps) {
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {pages.map((page) => {
          const title = getPageTitle(page);
          const icon = getPageIcon(page);
          
          // Try to extract status from properties
          let status: string | undefined;
          let dateStr: string | undefined;
          
          if (page.properties) {
            // Find status property
            const statusProp = Object.values(page.properties).find(
              (p: any) => p?.type === 'status' || p?.type === 'select'
            ) as any;
            if (statusProp?.status?.name) {
              status = statusProp.status.name;
            } else if (statusProp?.select?.name) {
              status = statusProp.select.name;
            }
            
            // Find date property
            const dateProp = Object.values(page.properties).find(
              (p: any) => p?.type === 'date'
            ) as any;
            if (dateProp?.date?.start) {
              dateStr = formatDate(dateProp.date.start);
            }
          }
          
          // Fallback to lastEditedTime
          if (!dateStr && page.lastEditedTime) {
            dateStr = formatDate(page.lastEditedTime);
          }

          return (
            <XStack
              key={page.id}
              alignItems="center"
              gap={10}
              paddingVertical={6}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
              hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.02)' }}
              cursor="pointer"
              onPress={() => page.url && Linking.openURL(page.url)}
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
              {status && <PageStatusBadge status={status} />}
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

interface DatabaseDetailBlockProps {
  database: NotionDatabase;
  variant?: 'created' | 'default';
}

function DatabaseDetailBlock({ database, variant = 'default' }: DatabaseDetailBlockProps) {
  const bgColors = {
    created: 'rgba(34,197,94,0.1)',
    default: colors.bgInner,
  };

  const icon = database.icon?.type === 'emoji' && database.icon.emoji 
    ? database.icon.emoji 
    : '🗃️';

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
        <Text flex={1} color={colors.bright} fontSize={12} fontWeight="500" numberOfLines={1}>
          {database.title || 'Untitled Database'}
        </Text>
        {database.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(database.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={colors.secondary} />
          </XStack>
        )}
      </XStack>

      {/* Description */}
      {database.description && (
        <Text color={colors.secondary} fontSize={10} numberOfLines={2}>
          {database.description}
        </Text>
      )}

      {/* Properties summary */}
      {database.properties && (
        <XStack gap={4} flexWrap="wrap">
          {Object.keys(database.properties).slice(0, 6).map((propName, idx) => (
            <XStack
              key={idx}
              backgroundColor={colors.badgeGray.bg}
              paddingHorizontal={5}
              paddingVertical={1}
              borderRadius={3}
            >
              <Text fontSize={8} color={colors.badgeGray.text}>
                {propName}
              </Text>
            </XStack>
          ))}
          {Object.keys(database.properties).length > 6 && (
            <Text fontSize={8} color={colors.muted}>
              +{Object.keys(database.properties).length - 6} more
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
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(true); // Expanded by default for query results
  
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
  if (status === 'completed' && hasPages) {
    badge = <Badge text={`${pages!.length} pages`} variant="gray" />;
  } else if (status === 'completed' && pages?.length === 0) {
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
        <FilterBlock filter={input?.filter} sorts={input?.sorts} />
        
        {/* Results */}
        {hasPages && <PageListBlock pages={pages!} />}
        {status === 'completed' && pages?.length === 0 && (
          <XStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={colors.muted} fontSize={10}>
              No pages match the filter criteria
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetDatabaseRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionDatabase>(output) : null;
  const isDatabase = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = input?.databaseId 
    ? `Get database` 
    : 'Get database';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDatabase) {
    const db = parsed as NotionDatabase;
    badge = <Badge text={truncate(db.title || 'Untitled', 20)} variant="info" />;
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
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateDatabaseRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
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
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} variant="created" />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function UpdateDatabaseSchemaRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionDatabase | string>(output) : null;
  const isDatabase = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Update database schema';

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
        {isDatabase && <DatabaseDetailBlock database={parsed as NotionDatabase} />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
