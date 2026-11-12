/**
 * Todo List MCA — UI Resource: Node Detail
 *
 * Shows a single node with its instructions (markdown) and chronological log.
 * The host renders a detail card with sections. Data comes from the backend
 * action `todo/get-node`.
 */

import type { ToolContext, UiResourceData } from '@teros/mca-sdk';
import { invoke } from '../client';
import type { NodeDetail } from '../lib/types';

export const detailResource = {
  name: 'detail',
  description: 'Node detail panel — shows instructions (markdown) + chronological log',
  resourceType: 'detail' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The node ID to display.',
      },
    },
    required: ['nodeId'],
  },
  boundTools: ['get-node'],
  refreshOnEvents: ['node.updated', 'node.completed'],
  handler: async (
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<UiResourceData> => {
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId : '';
    if (!nodeId) throw new Error('[INVALID_INPUT] Parameter "nodeId" is required.');

    // A missing node surfaces as `[NOT_FOUND] Node "<id>" not found.` from the action.
    const { node } = await invoke<{ node: NodeDetail }>(context, 'get-node', { nodeId });

    // Build sections: Overview + Instructions + Log
    const sections = [];

    // Overview section
    sections.push({
      title: 'Overview',
      icon: 'info',
      fields: [
        { label: 'Title', value: node.text, type: 'text' as const },
        { label: 'Description', value: node.description || '(none)', type: 'text' as const },
        { label: 'Completed', value: node.completed, type: 'text' as const },
        { label: 'Position', value: node.position, type: 'text' as const },
        { label: 'Parent', value: node.parentId ?? '(root)', type: 'text' as const },
        {
          label: 'Created',
          value: new Date(node.createdAt).toISOString(),
          type: 'date' as const,
        },
        {
          label: 'Updated',
          value: new Date(node.updatedAt).toISOString(),
          type: 'date' as const,
        },
      ],
    });

    // Instructions section (markdown)
    if (node.instructions) {
      sections.push({
        title: 'Instructions',
        icon: 'document',
        fields: [
          { label: 'Instructions', value: node.instructions, type: 'markdown' as const },
        ],
      });
    }

    // Log section (chronological history)
    if (node.log && node.log.length > 0) {
      sections.push({
        title: `Log (${node.log.length} entries)`,
        icon: 'clock',
        fields: node.log.map((entry: { timestamp: number; text: string }) => ({
          label: new Date(entry.timestamp).toISOString(),
          value: entry.text,
          type: 'text' as const,
        })),
      });
    }

    return {
      type: 'detail',
      title: node.text,
      subtitle: node.description || undefined,
      sections,
      badge: node.completed ? 'completed' : 'active',
    };
  },
};
