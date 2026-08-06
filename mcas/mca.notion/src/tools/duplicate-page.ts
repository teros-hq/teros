import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getAllBlocks, getNotionClient } from '../lib';
import { resolveDataSourceId } from './_data-source-resolver';
import { PAGE_COMPACT_FIELDS } from './_fields';
import { extractPageShape, resolveNotionId, sanitiseBlockForAppend } from './_notion-helpers';
import { resolveFields, wrapNotionCall, wrapNotionWrite } from './utils';

export const duplicatePage: ToolConfig = {
  description:
    'Duplicate a page including icon/cover/properties/children blocks. Returns { sourcePage, duplicate } with curated shapes. Not retryable — creates new pages each call.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Source page UUID.',
      },
      newTitle: {
        type: 'string',
        description: "New title. Default: 'Copy of <original title>'.",
      },
      targetParentId: {
        type: 'string',
        description: 'Target parent UUID. Default: same parent as source.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on both pages.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion objects. Default false.',
      },
    },
    required: ['pageId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      pageId: rawPageId,
      newTitle,
      targetParentId: rawTargetParentId,
      fields,
      includeRaw,
    } = args as {
      pageId: string;
      newTitle?: string;
      targetParentId?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');
    const targetParentId = rawTargetParentId
      ? resolveNotionId(rawTargetParentId, 'targetParentId')
      : undefined;

    const originalPage: any = await wrapNotionCall(() =>
      client.pages.retrieve({ page_id: pageId }),
    );
    const blocks = await wrapNotionCall(() => getAllBlocks(client, pageId));

    // Original page parent shapes can be `database_id` (legacy / 2022-06-28),
    // `data_source_id` (2025-09-03+), or `page_id`. When duplicating into a
    // new database we always rewrite the parent to `data_source_id` so it
    // works on multi-source DBs out of the box.
    const originalParentType = originalPage.parent?.type;
    const isDbLikeParent =
      originalParentType === 'database_id' || originalParentType === 'data_source_id';

    let parent: Record<string, string>;
    if (targetParentId) {
      if (isDbLikeParent) {
        const targetDataSourceId = await resolveDataSourceId(client, targetParentId);
        parent = { data_source_id: targetDataSourceId };
      } else {
        parent = { page_id: targetParentId };
      }
    } else if (originalParentType === 'database_id') {
      const sourceDataSourceId = await resolveDataSourceId(client, originalPage.parent.database_id);
      parent = { data_source_id: sourceDataSourceId };
    } else {
      parent = originalPage.parent;
    }

    let title = newTitle;
    if (!title) {
      const originalTitle =
        originalPage.properties.title?.title?.[0]?.plain_text ||
        originalPage.properties.Name?.title?.[0]?.plain_text ||
        'Untitled';
      title = `Copy of ${originalTitle}`;
    }

    const properties = { ...originalPage.properties };
    if (isDbLikeParent) {
      properties.Name = { title: [{ text: { content: title } }] };
    } else {
      properties.title = [{ text: { content: title } }];
    }

    const newPage: any = await wrapNotionWrite(() =>
      client.pages.create({
        parent,
        properties,
        icon: originalPage.icon,
        cover: originalPage.cover,
      } as any),
    );

    // Blocks come from retrieve with read-only metadata (id, timestamps,
    // icon: null, ...) that Notion rejects on append. Reshape each block
    // to the minimal accepted payload before reposting.
    if (blocks.length > 0) {
      const sanitisedChildren = blocks
        .map(sanitiseBlockForAppend)
        .filter((b): b is NonNullable<typeof b> => b !== null);
      if (sanitisedChildren.length > 0) {
        await wrapNotionWrite(() =>
          client.blocks.children.append({
            block_id: newPage.id,
            children: sanitisedChildren as any,
          }),
        );
      }
    }

    const sourceShape = extractPageShape(originalPage);
    const duplicateShape = extractPageShape(newPage);
    return {
      sourcePage: resolveFields(sourceShape as any, originalPage, {
        includeRaw,
        fields,
        defaultFields: PAGE_COMPACT_FIELDS,
      }),
      duplicate: resolveFields(duplicateShape as any, newPage, {
        includeRaw,
        fields,
        defaultFields: PAGE_COMPACT_FIELDS,
      }),
      blocksCopied: blocks.length,
    };
  },
};
