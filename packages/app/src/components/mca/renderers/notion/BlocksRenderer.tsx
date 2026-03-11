/**
 * Notion Renderer - Block Operations
 *
 * Handles: get-block, get-block-children, append-blocks, update-block, delete-block, 
 *          create-column-layout, create-advanced-blocks
 */

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
  type NotionBlock,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface BlockListBlockProps {
  blocks: NotionBlock[];
}

function BlockListBlock({ blocks }: BlockListBlockProps) {
  const getBlockIcon = (type: string): string => {
    const icons: Record<string, string> = {
      paragraph: '¶',
      heading_1: 'H1',
      heading_2: 'H2',
      heading_3: 'H3',
      bulleted_list_item: '•',
      numbered_list_item: '1.',
      to_do: '☐',
      toggle: '▸',
      code: '</>',
      quote: '"',
      callout: '💡',
      divider: '—',
      table: '⊞',
      image: '🖼',
      video: '🎬',
      file: '📎',
      pdf: '📄',
      bookmark: '🔖',
      embed: '⎔',
      column_list: '⫾',
      column: '⫿',
      synced_block: '🔗',
    };
    return icons[type] || '□';
  };

  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {blocks.map((block, idx) => (
          <XStack
            key={block.id || idx}
            alignItems="center"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={10}
            borderBottomWidth={1}
            borderBottomColor={colors.border}
          >
            <Text fontSize={10} color={colors.muted} width={24} textAlign="center" fontFamily="$mono">
              {getBlockIcon(block.type)}
            </Text>
            <Text flex={1} color={colors.primary} fontSize={10}>
              {block.type.replace(/_/g, ' ')}
            </Text>
            {block.hasChildren && (
              <XStack
                backgroundColor={colors.badgeGray.bg}
                paddingHorizontal={4}
                paddingVertical={1}
                borderRadius={3}
              >
                <Text fontSize={8} color={colors.badgeGray.text}>
                  has children
                </Text>
              </XStack>
            )}
            <Text fontSize={8} color={colors.muted} fontFamily="$mono">
              {block.id.slice(0, 8)}...
            </Text>
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

interface BlockDetailBlockProps {
  block: NotionBlock;
}

function BlockDetailBlock({ block }: BlockDetailBlockProps) {
  return (
    <YStack
      backgroundColor={colors.bgInner}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      <XStack alignItems="center" gap={8}>
        <Text fontSize={10} color={colors.muted} fontFamily="$mono">
          Type:
        </Text>
        <Text color={colors.primary} fontSize={11} fontWeight="500">
          {block.type.replace(/_/g, ' ')}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={8}>
        <Text fontSize={10} color={colors.muted} fontFamily="$mono">
          ID:
        </Text>
        <Text color={colors.secondary} fontSize={10} fontFamily="$mono">
          {block.id}
        </Text>
      </XStack>
      {block.hasChildren && (
        <XStack alignItems="center" gap={8}>
          <Text fontSize={10} color={colors.muted} fontFamily="$mono">
            Children:
          </Text>
          <Text color={colors.badgeInfo.text} fontSize={10}>
            Has nested blocks
          </Text>
        </XStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function GetBlockRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionBlock>(output) : null;
  const isBlock = parsed && typeof parsed === 'object' && 'type' in parsed;

  const description = 'Get block';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isBlock) {
    const block = parsed as NotionBlock;
    badge = <Badge text={block.type.replace(/_/g, ' ')} variant="info" />;
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
        {isBlock && <BlockDetailBlock block={parsed as NotionBlock} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetBlockChildrenRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  
  const parsed = output
    ? parseOutput<{ results?: NotionBlock[]; blocks?: NotionBlock[] } | NotionBlock[]>(output)
    : null;

  let blocks: NotionBlock[] | null = null;
  if (parsed && typeof parsed === 'object') {
    if ('results' in parsed && Array.isArray(parsed.results)) {
      blocks = parsed.results;
    } else if ('blocks' in parsed && Array.isArray(parsed.blocks)) {
      blocks = parsed.blocks;
    } else if (Array.isArray(parsed)) {
      blocks = parsed;
    }
  }

  const hasBlocks = blocks && blocks.length > 0;

  const description = 'Get block children';

  let badge: React.ReactNode = null;
  if (status === 'completed' && hasBlocks) {
    badge = <Badge text={`${blocks!.length} blocks`} variant="gray" />;
  } else if (status === 'completed' && blocks?.length === 0) {
    badge = <Badge text="empty" variant="gray" />;
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
        {hasBlocks && <BlockListBlock blocks={blocks!} />}
        {status === 'completed' && blocks?.length === 0 && (
          <XStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={colors.muted} fontSize={10}>
              No child blocks
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function AppendBlocksRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const blockCount = input?.blocks?.length || 0;
  const description = blockCount > 0 
    ? `Append ${blockCount} block${blockCount > 1 ? 's' : ''}`
    : 'Append blocks';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="appended" variant="success" />;
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
        <SuccessBlock message={`Successfully appended ${blockCount} block${blockCount > 1 ? 's' : ''}`} />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function UpdateBlockRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionBlock | string>(output) : null;
  const isBlock = parsed && typeof parsed === 'object' && 'type' in parsed;

  const description = 'Update block';

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
        {isBlock && <BlockDetailBlock block={parsed as NotionBlock} />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function DeleteBlockRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const description = 'Delete block';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="warning" />;
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
        <SuccessBlock message="Block archived successfully" />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateColumnLayoutRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const columnCount = input?.columns?.length || 0;
  const description = columnCount > 0 
    ? `Create ${columnCount}-column layout`
    : 'Create column layout';

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
        <SuccessBlock message={`Created ${columnCount}-column layout`} />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateAdvancedBlocksRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const blockType = input?.blockType || 'block';
  const description = `Create ${blockType.replace(/_/g, ' ')}`;

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
        <SuccessBlock message={`Created ${blockType.replace(/_/g, ' ')} block`} />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
