/**
 * Notion MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import { ToolCallCard } from '../primitives';
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
  GetBlocksRenderer,
  UpdateBlockRenderer,
} from './notion/BlocksRenderer';

import { HealthCheckRenderer as NotionHealthCheckRenderer } from './notion/HealthCheckRenderer';

import {
  CreateDatabaseRenderer,
  GetDatabaseRenderer,
  QueryDatabaseRenderer,
  UpdateDatabaseSchemaRenderer,
} from './notion/DatabaseRenderer';

import {
  CreateDatabaseItemRenderer,
  CreatePageRenderer,
  DuplicatePageRenderer,
  GetPageMarkdownRenderer,
  GetPageRenderer,
  SearchRenderer,
  SetPageCoverRenderer,
  SetPageIconRenderer,
  UpdateDatabaseItemRenderer,
  UpdatePageMarkdownRenderer,
  UpdatePageRenderer,
} from './notion/PagesRenderer';

import {
  CreateCommentRenderer,
  DeleteCommentRenderer,
  GetMeRenderer,
  GetUserRenderer,
  ListCommentsRenderer,
  ListUsersRenderer,
  UpdateCommentRenderer,
} from './notion/UsersCommentsRenderer';

import { UploadFileRenderer } from './notion/UploadFileRenderer';

import { Badge, getShortToolName, HeaderRow } from './notion/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Search
  'search': SearchRenderer,

  // Pages
  'get-page': GetPageRenderer,
  'get-page-markdown': GetPageMarkdownRenderer,
  'create-page': CreatePageRenderer,
  'update-page': UpdatePageRenderer,
  'update-page-markdown': UpdatePageMarkdownRenderer,
  'duplicate-page': DuplicatePageRenderer,
  'set-page-icon': SetPageIconRenderer,
  'set-page-cover': SetPageCoverRenderer,

  // Databases
  'get-database': GetDatabaseRenderer,
  'query-database': QueryDatabaseRenderer,
  'create-database': CreateDatabaseRenderer,
  'update-database-schema': UpdateDatabaseSchemaRenderer,
  'create-database-item': CreateDatabaseItemRenderer,
  'update-database-item': UpdateDatabaseItemRenderer,

  // Blocks
  'get-block': GetBlockRenderer,
  'get-block-children': GetBlockChildrenRenderer,
  'get-blocks': GetBlocksRenderer,
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
  'update-comment': UpdateCommentRenderer,
  'delete-comment': DeleteCommentRenderer,

  // File uploads
  'upload-file': UploadFileRenderer,

  // Leading dash: tool name is `notion_-health-check`; `getShortToolName` splits on `_` so the suffix carries the dash.
  '-health-check': NotionHealthCheckRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  // With 100% coverage this branch should never fire in production.
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      `[NotionRenderer] missing dedicated renderer for tool: ${toolName}. ` +
        'Add a sub-renderer and register it in RENDERERS.',
    );
  }

  const badge =
    status === 'completed' ? (
      <Badge text="done (fallback)" variant="warning" />
    ) : status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description={`${shortName.replace(/-/g, ' ')} (no renderer)`}
      badge={badge}
      iconUri={appIcon}
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
