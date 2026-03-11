import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest, stripHtml } from '../lib';

export const getConversation: ToolConfig = {
  description:
    'Get the full details of a specific Intercom conversation by ID, including all messages, notes, tags, and assignee.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The Intercom conversation ID',
      },
    },
    required: ['conversationId'],
  },
  handler: async (args, context) => {
    const { conversationId } = args as { conversationId: string };

    const c = (await intercomRequest(
      context,
      `/conversations/${conversationId}`,
    )) as Record<string, unknown>;

    const parts = ((c.conversation_parts as any)?.conversation_parts ?? []).map((p: any) => ({
      type: p.part_type,
      author: { type: p.author?.type, name: p.author?.name },
      body: stripHtml(p.body ?? ''),
      createdAt: p.created_at,
    }));

    return {
      id: c.id,
      state: c.state,
      priority: c.priority,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      source: {
        type: (c.source as any)?.type,
        subject: (c.source as any)?.subject,
        body: stripHtml((c.source as any)?.body ?? ''),
        author: (c.source as any)?.author,
      },
      assignee: (c.assignee as any)?.name ?? null,
      team: (c.team_assignee as any)?.name ?? null,
      tags: ((c.tags as any)?.tags ?? []).map((t: any) => t.name),
      parts,
    };
  },
};
