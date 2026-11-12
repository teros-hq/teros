/**
 * Todo List MCA — UI Resource: Tree View
 *
 * Renders the full node tree as a collapsible/expandable hierarchy.
 * The host interprets the TreeNode[] structure and renders it natively.
 * Data comes from the backend action `todo/get-tree` (the resource handler
 * receives the same ToolContext as a tool, including the backend client).
 */

import type { ToolContext, TreeNode, UiResourceData } from '@teros/mca-sdk';
import { invoke } from '../client';
import type { FormattedNode } from '../lib/types';

/**
 * Convert a FormattedNode (action shape) into a TreeNode (UI shape).
 * Completed nodes get a badge, collapsed nodes are marked expanded=false.
 */
function toTreeNode(node: FormattedNode): TreeNode {
  const children = node.children?.map(toTreeNode);
  return {
    id: node.nodeId,
    label: node.text,
    icon: node.completed ? 'check-circle' : node.childCount > 0 ? 'folder' : 'circle',
    badge: node.childCount > 0
      ? `${node.completedChildren}/${node.childCount} done`
      : node.completed
        ? '✓'
        : undefined,
    expanded: !node.collapsed,
    ...(children ? { children } : {}),
    meta: {
      nodeId: node.nodeId,
      parentId: node.parentId,
      completed: node.completed,
      position: node.position,
      description: node.description,
    },
  };
}

export const treeResource = {
  name: 'tree',
  description: 'Full tree of todo nodes — collapsible/expandable hierarchy view',
  resourceType: 'tree' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'Optional: get only the subtree rooted at this node.',
      },
      depth: {
        type: 'number',
        description: 'Tree depth to return. -1 = full tree (default), 0 = root level only, N = N levels of children.',
      },
    },
  },
  boundTools: ['get-tree'],
  refreshOnEvents: ['node.added', 'node.updated', 'node.completed', 'node.moved', 'node.deleted'],
  handler: async (
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<UiResourceData> => {
    const nodeId = typeof params.nodeId === 'string' && params.nodeId.trim()
      ? params.nodeId
      : undefined;
    const depth = typeof params.depth === 'number' ? params.depth : -1;
    const { tree } = await invoke<{ tree: FormattedNode[] }>(context, 'get-tree', {
      ...(nodeId ? { nodeId } : {}),
      depth,
    });
    return {
      type: 'tree',
      nodes: tree.map(toTreeNode),
      title: 'My Tasks',
    };
  },
};
