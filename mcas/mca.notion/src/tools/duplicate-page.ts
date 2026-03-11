import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getAllBlocks, getNotionClient } from '../lib';

export const duplicatePage: ToolConfig = {
  description: 'Duplicate a page with all its content and properties.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to duplicate',
      },
      newTitle: {
        type: 'string',
        description:
          "Title for the duplicated page (optional, defaults to 'Copy of [original title]')",
      },
      targetParentId: {
        type: 'string',
        description:
          'ID of the parent page/database where to place the duplicate (optional, defaults to same parent)',
      },
    },
    required: ['pageId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, newTitle, targetParentId } = args as {
      pageId: string;
      newTitle?: string;
      targetParentId?: string;
    };

    // Get original page
    const originalPage: any = await client.pages.retrieve({ page_id: pageId });

    // Get all blocks from original page
    const blocks = await getAllBlocks(client, pageId);

    // Determine parent
    const parent = targetParentId
      ? originalPage.parent.type === 'database_id'
        ? { database_id: targetParentId }
        : { page_id: targetParentId }
      : originalPage.parent;

    // Create title
    let title = newTitle;
    if (!title) {
      const originalTitle =
        originalPage.properties.title?.title?.[0]?.plain_text ||
        originalPage.properties.Name?.title?.[0]?.plain_text ||
        'Untitled';
      title = `Copy of ${originalTitle}`;
    }

    // Create new page with same properties
    const properties = { ...originalPage.properties };
    if (originalPage.parent.type === 'database_id') {
      properties.Name = {
        title: [{ text: { content: title } }],
      };
    } else {
      properties.title = [{ text: { content: title } }];
    }

    const newPage = await client.pages.create({
      parent,
      properties,
      icon: originalPage.icon,
      cover: originalPage.cover,
    } as any);

    // Copy all blocks
    if (blocks.length > 0) {
      await client.blocks.children.append({
        block_id: newPage.id,
        children: blocks as any,
      });
    }

    return {
      success: true,
      originalPageId: pageId,
      newPageId: newPage.id,
      newPage,
    };
  },
};
