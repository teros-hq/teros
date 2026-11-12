/**
 * Todo List MCA — UI Resource: Add/Edit Form
 *
 * Form for creating or editing a node.
 * Fields: text (string), description (string), instructions (markdown textarea).
 * When nodeId is provided, the form pre-fills with existing values (edit mode)
 * fetched through the backend action `todo/get-node`.
 * Submit calls the 'add-node' or 'update-node' tool depending on mode.
 */

import type { ToolContext, UiResourceData } from '@teros/mca-sdk';
import { invoke } from '../client';
import type { NodeDetail } from '../lib/types';

export const formResource = {
  name: 'form',
  description: 'Add/edit a todo node — fields: text, description, instructions (markdown)',
  resourceType: 'form' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'If provided, the form edits an existing node. If omitted, creates a new one.',
      },
      parentId: {
        type: 'string',
        description: 'Parent node ID for new nodes. Omit or null for root-level.',
      },
    },
  },
  boundTools: ['add-node', 'update-node'],
  refreshOnEvents: [],
  handler: async (
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<UiResourceData> => {
    const nodeId = typeof params.nodeId === 'string' && params.nodeId.trim()
      ? params.nodeId
      : undefined;

    // Edit mode: pre-fill from existing node
    if (nodeId) {
      // A missing node surfaces as `[NOT_FOUND] Node "<id>" not found.` from the action.
      const { node } = await invoke<{ node: NodeDetail }>(context, 'get-node', { nodeId });

      return {
        type: 'form',
        title: `Edit: ${node.text}`,
        description: 'Update the node title, description, or instructions.',
        fields: [
          {
            name: 'nodeId',
            label: 'Node ID',
            fieldType: 'text' as const,
            defaultValue: node.nodeId,
            helpText: 'The node being edited (read-only).',
          },
          {
            name: 'text',
            label: 'Title',
            fieldType: 'text' as const,
            defaultValue: node.text,
            placeholder: 'Enter a title...',
            required: true,
            helpText: 'The node title. Max 2000 chars.',
          },
          {
            name: 'description',
            label: 'Description',
            fieldType: 'text' as const,
            defaultValue: node.description || '',
            placeholder: 'Short description...',
            helpText: 'A short description shown under the title.',
          },
          {
            name: 'instructions',
            label: 'Instructions (Markdown)',
            fieldType: 'textarea' as const,
            defaultValue: node.instructions || '',
            placeholder: 'Detailed markdown instructions for this task...',
            helpText: 'Full markdown instructions. Max 10000 chars.',
          },
        ],
        submitLabel: 'Update Node',
        cancelLabel: 'Cancel',
        submitTool: 'update-node',
      };
    }

    // Add mode: empty form for creating a new node
    const parentId = typeof params.parentId === 'string' && params.parentId.trim()
      ? params.parentId
      : undefined;

    return {
      type: 'form',
      title: 'Add New Node',
      description: 'Create a new todo node in the tree.',
      fields: [
        ...(parentId
          ? [{
              name: 'parentId',
              label: 'Parent Node ID',
              fieldType: 'text' as const,
              defaultValue: parentId,
              helpText: 'The new node will be added as a child of this node.',
            }]
          : []),
        {
          name: 'text',
          label: 'Title',
          fieldType: 'text' as const,
          placeholder: 'Enter a title...',
          required: true,
          helpText: 'The node title. Max 2000 chars.',
        },
        {
          name: 'description',
          label: 'Description',
          fieldType: 'text' as const,
          placeholder: 'Short description...',
          helpText: 'A short description shown under the title.',
        },
        {
          name: 'instructions',
          label: 'Instructions (Markdown)',
          fieldType: 'textarea' as const,
          placeholder: 'Detailed markdown instructions for this task...',
          helpText: 'Full markdown instructions. Max 10000 chars.',
        },
      ],
      submitLabel: 'Add Node',
      cancelLabel: 'Cancel',
      submitTool: 'add-node',
    };
  },
};
