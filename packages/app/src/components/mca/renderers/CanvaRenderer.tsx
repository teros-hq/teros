/**
 * Canva MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 35/35 tools covered + -health-check. The `FallbackRenderer` is a
 * dev-only warning that a sub-renderer is missing — in production it
 * should never render.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';

import {
  Badge,
  FallbackBody,
  ToolCallCard,
  colors as globalColors,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { HealthCheckRenderer } from './canva/HealthCheckRenderer';
import {
  DeleteAssetRenderer,
  GetAssetRenderer,
  GetAssetUploadJobRenderer,
  UpdateAssetRenderer,
  UploadAssetRenderer,
} from './canva/AssetsRenderer';
import {
  AutofillDesignRenderer,
  GetAutofillJobRenderer,
  GetBrandTemplateDatasetRenderer,
  GetBrandTemplateRenderer,
  ListBrandTemplatesRenderer,
} from './canva/BrandTemplatesRenderer';
import {
  CreateReplyRenderer,
  CreateThreadRenderer,
  GetReplyRenderer,
  GetThreadRenderer,
  ListRepliesRenderer,
} from './canva/CommentsRenderer';
import {
  CreateDesignRenderer,
  GetDesignExportFormatsRenderer,
  GetDesignPagesRenderer,
  GetDesignRenderer,
  ListDesignsRenderer,
} from './canva/DesignsRenderer';
import {
  CreateResizeJobRenderer,
  ExportDesignRenderer,
  GetExportJobRenderer,
  GetResizeJobRenderer,
} from './canva/ExportsRenderer';
import {
  CreateFolderRenderer,
  DeleteFolderRenderer,
  GetFolderRenderer,
  ListFoldersRenderer,
  MoveItemRenderer,
  UpdateFolderRenderer,
} from './canva/FoldersRenderer';
import { GetImportJobRenderer, ImportDesignRenderer } from './canva/ImportsRenderer';
import { CANVA_ICON, getShortToolName, getToolLabel, toolStatusForPrimitive } from './canva/shared';
import {
  GetUserCapabilitiesRenderer,
  GetUserProfileRenderer,
  GetUserRenderer,
} from './canva/UserRenderer';

// ============================================================================
// Registry — 36/36 coverage (35 tools + health check)
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  // Users
  'get-user': GetUserRenderer,
  'get-user-profile': GetUserProfileRenderer,
  'get-user-capabilities': GetUserCapabilitiesRenderer,
  // Designs
  'list-designs': ListDesignsRenderer,
  'get-design': GetDesignRenderer,
  'create-design': CreateDesignRenderer,
  'get-design-pages': GetDesignPagesRenderer,
  'get-design-export-formats': GetDesignExportFormatsRenderer,
  // Exports + resizes
  'export-design': ExportDesignRenderer,
  'get-export-job': GetExportJobRenderer,
  'create-resize-job': CreateResizeJobRenderer,
  'get-resize-job': GetResizeJobRenderer,
  // Imports
  'import-design': ImportDesignRenderer,
  'get-import-job': GetImportJobRenderer,
  // Folders
  'list-folders': ListFoldersRenderer,
  'get-folder': GetFolderRenderer,
  'create-folder': CreateFolderRenderer,
  'update-folder': UpdateFolderRenderer,
  'delete-folder': DeleteFolderRenderer,
  'move-item': MoveItemRenderer,
  // Assets
  'upload-asset': UploadAssetRenderer,
  'get-asset-upload-job': GetAssetUploadJobRenderer,
  'get-asset': GetAssetRenderer,
  'update-asset': UpdateAssetRenderer,
  'delete-asset': DeleteAssetRenderer,
  // Brand templates + autofill
  'list-brand-templates': ListBrandTemplatesRenderer,
  'get-brand-template': GetBrandTemplateRenderer,
  'get-brand-template-dataset': GetBrandTemplateDatasetRenderer,
  'autofill-design': AutofillDesignRenderer,
  'get-autofill-job': GetAutofillJobRenderer,
  // Comments
  'create-thread': CreateThreadRenderer,
  'get-thread': GetThreadRenderer,
  'list-replies': ListRepliesRenderer,
  'create-reply': CreateReplyRenderer,
  'get-reply': GetReplyRenderer,
};

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={CANVA_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in CanvaRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

// ============================================================================
// Entry point
// ============================================================================

function CanvaRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const CanvaToolCallRenderer = withPermissionSupport(CanvaRendererBase);
export default CanvaToolCallRenderer;
