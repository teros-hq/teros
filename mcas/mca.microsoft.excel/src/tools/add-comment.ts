import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, worksheetRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const addComment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add a comment to a cell, or list / delete / update comments on a worksheet. Use list:true to list all comments, deleteId to delete a comment by its id, or updateId + content to update a comment.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'Workbook drive item ID. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Workbook path relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      worksheet: { type: 'string', description: 'Worksheet name or id' },
      cell: {
        type: 'string',
        description: 'Target cell in A1 notation, e.g. "A1". Required when adding a comment.',
      },
      content: {
        type: 'string',
        description: 'Comment text. Required when adding or updating a comment.',
      },
      list: {
        type: 'boolean',
        description: 'When true, list all comments on the worksheet.',
      },
      deleteId: {
        type: 'string',
        description: 'When set, delete the comment with this id.',
      },
      updateId: {
        type: 'string',
        description: 'When set, update the comment with this id. Requires content.',
      },
    },
    required: ['worksheet'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'Excel',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const wsRef = worksheetRef(a)

    // List mode
    if (a.list === true) {
      const result = await graphRequest<Record<string, any>>('GET', `${wsRef}/comments`)
      const comments = (result?.value ?? []) as any[]
      return {
        success: true,
        account: email,
        worksheet: a.worksheet as string,
        count: comments.length,
        comments: comments.map((c) => ({
          id: c.id,
          content: c.content,
          author: c.author?.displayName,
          createdAt: c.createdDateTime,
          cell: c.cellRef ?? c.targetRange,
        })),
      }
    }

    // Delete mode
    if (a.deleteId) {
      await graphRequest('DELETE', `${wsRef}/comments/${encodeURIComponent(a.deleteId as string)}`)
      return {
        success: true,
        account: email,
        worksheet: a.worksheet as string,
        action: 'deleted',
        commentId: a.deleteId,
      }
    }

    // Update mode
    if (a.updateId) {
      if (!a.content) {
        throw new Error('Updating a comment requires content.')
      }
      const result = await graphRequest<Record<string, any>>(
        'PATCH',
        `${wsRef}/comments/${encodeURIComponent(a.updateId as string)}`,
        { content: a.content },
      )
      return {
        success: true,
        account: email,
        worksheet: a.worksheet as string,
        action: 'updated',
        commentId: a.updateId,
        content: result?.content ?? a.content,
      }
    }

    // Add mode
    if (!a.cell) {
      throw new Error('Specify cell (e.g. "A1") to add a comment, or set list:true, deleteId, or updateId.')
    }
    if (!a.content) {
      throw new Error('Specify content (the comment text) to add a comment.')
    }

    const result = await graphRequest<Record<string, any>>(
      'POST',
      `${wsRef}/comments/add`,
      {
        targetRange: a.cell,
        content: a.content,
      },
    )

    return {
      success: true,
      account: email,
      worksheet: a.worksheet as string,
      action: 'added',
      commentId: result?.id,
      cell: a.cell,
      content: result?.content ?? a.content,
    }
  },
}
