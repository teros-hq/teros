/**
 * Notion MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// Import sub-renderers
import {
  AppendBlocksRenderer,
  CreateAdvancedBlocksRenderer,
  CreateColumnLayoutRenderer,
  DeleteBlockRenderer,
  GetBlockChildrenRenderer,
  GetBlockRenderer,
  UpdateBlockRenderer,
} from './notion/BlocksRenderer';

import {
  CreateDatabaseRenderer,
  GetDatabaseRenderer,
  QueryDatabaseRenderer,
  UpdateDatabaseSchemaRenderer,
} from './notion/DatabaseRenderer';

import {
  CreatePageRenderer,
  DuplicatePageRenderer,
  GetPageContentRenderer,
  GetPageRenderer,
  SearchRenderer,
  SetPageCoverRenderer,
  SetPageIconRenderer,
  UpdatePageRenderer,
} from './notion/PagesRenderer';

import {
  CreateCommentRenderer,
  GetMeRenderer,
  GetUserRenderer,
  ListCommentsRenderer,
  ListUsersRenderer,
} from './notion/UsersCommentsRenderer';

import { Badge, getShortToolName, HeaderRow } from './notion/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Search
  'search': SearchRenderer,

  // Pages
  'get-page': GetPageRenderer,
  'get-page-content': GetPageContentRenderer,
  'create-page': CreatePageRenderer,
  'update-page': UpdatePageRenderer,
  'duplicate-page': DuplicatePageRenderer,
  'set-page-icon': SetPageIconRenderer,
  'set-page-cover': SetPageCoverRenderer,

  // Databases
  'get-database': GetDatabaseRenderer,
  'query-database': QueryDatabaseRenderer,
  'create-database': CreateDatabaseRenderer,
  'update-database-schema': UpdateDatabaseSchemaRenderer,

  // Blocks
  'get-block': GetBlockRenderer,
  'get-block-children': GetBlockChildrenRenderer,
  'append-blocks': AppendBlocksRenderer,
  'update-block': UpdateBlockRenderer,
  'delete-block': DeleteBlockRenderer,
  'create-column-layout': CreateColumnLayoutRenderer,
  'create-advanced-blocks': CreateAdvancedBlocksRenderer,

  // Users
  'list-users': ListUsersRenderer,
  'get-user': GetUserRenderer,
  'get-me': GetMeRenderer,

  // Comments
  'list-comments': ListCommentsRenderer,
  'create-comment': CreateCommentRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <HeaderRow
      status={status}
      description={shortName.replace(/-/g, ' ')}
      duration={duration}
      badge={badge}
      expanded={false}
      onToggle={() => {}}
    />
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function NotionRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const NotionToolCallRenderer = withPermissionSupport(NotionRendererBase);
export default NotionToolCallRenderer;
