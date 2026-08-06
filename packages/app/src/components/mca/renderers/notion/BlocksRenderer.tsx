/**
 * Notion Renderer - Block Operations
 *
 * Handles: get-block, get-block-children, append-blocks, update-block, delete-block, 
 *          create-column-layout, create-advanced-blocks
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, formatCountBadge } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useNotionColors,
  type NotionBlock,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface BlockListBlockProps {
  blocks: NotionBlock[];
}

function BlockListBlock({ blocks }: BlockListBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
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
      style={{ maxHeight: 250, backgroundColor: c.bgInner, borderRadius: 5 }}
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
            borderBottomColor={c.border}
          >
            <Text fontSize={10} color={c.text3} width={24} textAlign="center" fontFamily="$mono">
              {getBlockIcon(block.type)}
            </Text>
            <Text flex={1} color={c.text} fontSize={10} numberOfLines={1}>
              {block.plainText
                ? truncate(block.plainText, 60)
                : block.type.replace(/_/g, ' ')}
            </Text>
            {block.hasChildren && (
              <XStack
                backgroundColor={c.badges.gray.bg}
                paddingHorizontal={4}
                paddingVertical={1}
                borderRadius={3}
              >
                <Text fontSize={8} color={c.badges.gray.text}>
                  has children
                </Text>
              </XStack>
            )}
            <Text fontSize={8} color={c.text3} fontFamily="$mono">
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
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      <XStack alignItems="center" gap={8}>
        <Text fontSize={10} color={c.text3} fontFamily="$mono">
          Type:
        </Text>
        <Text color={c.text} fontSize={11} fontWeight="500">
          {block.type.replace(/_/g, ' ')}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={8}>
        <Text fontSize={10} color={c.text3} fontFamily="$mono">
          ID:
        </Text>
        <Text color={c.text2} fontSize={10} fontFamily="$mono">
          {block.id}
        </Text>
      </XStack>
      {block.hasChildren && (
        <XStack alignItems="center" gap={8}>
          <Text fontSize={10} color={c.text3} fontFamily="$mono">
            Children:
          </Text>
          <Text color={c.badges.info.text} fontSize={10}>
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
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

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



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isBlock && <BlockDetailBlock block={parsed as NotionBlock} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetBlockChildrenRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

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
    badge = (
      <Badge
        text={formatCountBadge(blocks!.length, 'block')}
        variant={countBadgeVariant(blocks!.length)}
      />
    );
  } else if (status === 'completed' && blocks?.length === 0) {
    badge = <Badge text="empty" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {hasBlocks && <BlockListBlock blocks={blocks!} />}
        {status === 'completed' && blocks?.length === 0 && (
          <XStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={c.text3} fontSize={10}>
              No child blocks
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function AppendBlocksRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  // New shape (TER-272): { parentId, blocks, appendedCount }. Legacy: raw Notion list.
  const parsed = output
    ? parseOutput<{ blocks?: NotionBlock[]; appendedCount?: number }>(output)
    : null;
  const appendedCount =
    (parsed && typeof parsed === 'object' && typeof (parsed as any).appendedCount === 'number'
      ? (parsed as any).appendedCount
      : undefined) ??
    input?.blocks?.length ??
    0;
  const appendedBlocks =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as any).blocks)
      ? ((parsed as any).blocks as NotionBlock[])
      : null;

  const description =
    appendedCount > 0
      ? `Append ${appendedCount} block${appendedCount === 1 ? '' : 's'}`
      : 'Append blocks';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="appended" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock
          message={`Successfully appended ${appendedCount} block${appendedCount === 1 ? '' : 's'}`}
        />
        {appendedBlocks && appendedBlocks.length > 0 && <BlockListBlock blocks={appendedBlocks} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

// ============================================================================
// GetBlocksRenderer — new tool registered in TER-272 (REQ-3)
// ============================================================================

export function GetBlocksRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

  const parsed = output
    ? parseOutput<{ blocks?: NotionBlock[]; total?: number; hasMore?: boolean; nextCursor?: string | null }>(
        output,
      )
    : null;

  const blocks =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as any).blocks)
      ? ((parsed as any).blocks as NotionBlock[])
      : null;
  const hasBlocks = !!blocks && blocks.length > 0;
  const hasMore = parsed && typeof parsed === 'object' ? !!(parsed as any).hasMore : false;

  const description = 'Get blocks';

  let badge: React.ReactNode = null;
  if (status === 'completed' && hasBlocks) {
    badge = (
      <Badge
        text={formatCountBadge(blocks!.length, 'block')}
        variant={countBadgeVariant(blocks!.length)}
      />
    );
  } else if (status === 'completed' && blocks?.length === 0) {
    badge = <Badge text="empty" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {hasBlocks && <BlockListBlock blocks={blocks!} />}
        {hasMore && (
          <Text color={c.text3} fontSize={9} fontFamily="$mono">
            … more blocks available — pass `cursor` to paginate
          </Text>
        )}
        {status === 'completed' && blocks?.length === 0 && (
          <XStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={c.text3} fontSize={10}>
              No child blocks
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdateBlockRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

  // New shape (TER-272): { block, oldText, newText }. Legacy: NotionBlock.
  const parsed = output
    ? parseOutput<
        { block?: NotionBlock; oldText?: string; newText?: string } | NotionBlock | string
      >(output)
    : null;

  const { block, oldText, newText } = (() => {
    const inputOld = typeof input?.oldText === 'string' ? (input.oldText as string) : undefined;
    const inputNew = typeof input?.newText === 'string' ? (input.newText as string) : undefined;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as any;
      if (p.block && typeof p.block === 'object') {
        return {
          block: p.block as NotionBlock,
          oldText: typeof p.oldText === 'string' ? p.oldText : inputOld,
          newText: typeof p.newText === 'string' ? p.newText : inputNew,
        };
      }
      if (p.id && p.type) {
        return { block: p as NotionBlock, oldText: inputOld, newText: inputNew };
      }
    }
    return { block: undefined, oldText: inputOld, newText: inputNew };
  })();

  const description = 'Update block';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="replaced" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {(oldText !== undefined || newText !== undefined) && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
            gap={6}
          >
            {oldText !== undefined && (
              <YStack
                backgroundColor="rgba(239,68,68,0.08)"
                borderRadius={4}
                paddingVertical={4}
                paddingHorizontal={6}
              >
                <Text fontSize={9} color={c.text3} fontFamily="$mono">
                  − old
                </Text>
                <Text fontSize={11} color={c.badges.err.text}>
                  {truncate(oldText, 140)}
                </Text>
              </YStack>
            )}
            {newText !== undefined && (
              <YStack
                backgroundColor="rgba(34,197,94,0.08)"
                borderRadius={4}
                paddingVertical={4}
                paddingHorizontal={6}
              >
                <Text fontSize={9} color={c.text3} fontFamily="$mono">
                  + new
                </Text>
                <Text fontSize={11} color={c.badges.ok.text}>
                  {truncate(newText, 140)}
                </Text>
              </YStack>
            )}
          </YStack>
        )}
        {block && <BlockDetailBlock block={block} />}
        {typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeleteBlockRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const description = 'Delete block';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message="Block archived successfully" />
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateColumnLayoutRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

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



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message={`Created ${columnCount}-column layout`} />
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateAdvancedBlocksRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const blockType = input?.blockType || 'block';
  const description = `Create ${blockType.replace(/_/g, ' ')}`;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message={`Created ${blockType.replace(/_/g, ' ')} block`} />
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
