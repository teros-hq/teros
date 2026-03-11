/**
 * Google Drive MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import {
  CreateCommentRenderer,
  CreateReplyRenderer,
  DeleteCommentRenderer,
  GetCommentRenderer,
  ListCommentsRenderer,
  ListRepliesRenderer,
  UpdateCommentRenderer,
} from './drive/CommentsRenderer';
import {
  ReadDocumentRenderer,
  ReadPresentationRenderer,
  ReadSlideRenderer,
  ReadSpreadsheetRenderer,
} from './drive/DocsRenderer';
// Import sub-renderers
import {
  CopyFileRenderer,
  DeleteFileRenderer,
  DownloadFileRenderer,
  GetFileContentRenderer,
  GetFileRenderer,
  ListFilesRenderer,
  MoveFileRenderer,
  SearchFilesRenderer,
  UploadFileRenderer,
} from './drive/FilesRenderer';
import { CreateFolderRenderer } from './drive/FoldersRenderer';
import { ShareFileRenderer } from './drive/SharingRenderer';

import {
  ExportSheetRenderer,
  ListSheetTabsRenderer,
  ReadSheetRangeRenderer,
} from './drive/SheetsRenderer';
import { Badge, getShortToolName, HeaderRow } from './drive/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Files
  'list-files': ListFilesRenderer,
  'search-files': SearchFilesRenderer,
  'get-file': GetFileRenderer,
  'get-file-content': GetFileContentRenderer,
  'download-file': DownloadFileRenderer,
  'upload-file': UploadFileRenderer,
  'move-file': MoveFileRenderer,
  'copy-file': CopyFileRenderer,
  'delete-file': DeleteFileRenderer,

  // Folders
  'create-folder': CreateFolderRenderer,

  // Sharing
  'share-file': ShareFileRenderer,

  // Google Docs
  'read-spreadsheet': ReadSpreadsheetRenderer,
  'read-presentation': ReadPresentationRenderer,
  'read-document': ReadDocumentRenderer,
  'read-slide': ReadSlideRenderer,

  // Sheets (advanced)
  'read-sheet-range': ReadSheetRangeRenderer,
  'list-sheet-tabs': ListSheetTabsRenderer,
  'export-sheet': ExportSheetRenderer,

  // Comments
  'create-comment': CreateCommentRenderer,
  'list-comments': ListCommentsRenderer,
  'get-comment': GetCommentRenderer,
  'update-comment': UpdateCommentRenderer,
  'delete-comment': DeleteCommentRenderer,
  'create-reply': CreateReplyRenderer,
  'list-replies': ListRepliesRenderer,
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
      description={shortName}
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

function DriveRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const DriveToolCallRenderer = withPermissionSupport(DriveRendererBase);
export default DriveToolCallRenderer;
