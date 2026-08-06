#!/usr/bin/env bun

/**
 * Canva MCA — Canva Connect API integration.
 *
 * Stateless HTTP transport. Secrets fetched per-handler from `context`.
 * Refresh tokens persisted via `context.updateUserSecrets`.
 *
 * Coverage:
 *   - Users (get-user, get-user-profile, get-user-capabilities)
 *   - Designs (list/get/create + pages + export-formats)
 *   - Exports / Resizes (async jobs)
 *   - Imports (URL imports)
 *   - Folders (full CRUD + move)
 *   - Assets (URL upload + CRUD)
 *   - Brand templates + autofill
 *   - Comments (threads + replies)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { canvaRequest } from './lib';
import {
  autofillDesign,
  createDesign,
  createFolder,
  createReply,
  createResizeJob,
  createThread,
  deleteAsset,
  deleteFolder,
  exportDesign,
  getAsset,
  getAssetUploadJob,
  getAutofillJob,
  getBrandTemplate,
  getBrandTemplateDataset,
  getDesign,
  getDesignExportFormats,
  getDesignPages,
  getExportJob,
  getFolder,
  getImportJob,
  getReply,
  getResizeJob,
  getThread,
  getUser,
  getUserCapabilities,
  getUserProfile,
  importDesign,
  listBrandTemplates,
  listDesigns,
  listFolders,
  listReplies,
  moveItem,
  updateAsset,
  updateFolder,
  uploadAsset,
} from './tools';

const MCA_VERSION = '1.1.0';

const server = new McaServer({
  id: 'mca.canva',
  name: 'Canva',
  version: MCA_VERSION,
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

server.tool('-health-check', {
  description:
    'Internal health check tool. Verifies OAuth credentials and connectivity to Canva.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion(MCA_VERSION)
      .setUptime(Math.floor(process.uptime()));

    try {
      const [systemSecrets, userSecrets] = await Promise.all([
        context.getSystemSecrets(),
        context.getUserSecrets(),
      ]);

      const clientId = systemSecrets.CLIENT_ID || systemSecrets.client_id;
      const clientSecret = systemSecrets.CLIENT_SECRET || systemSecrets.client_secret;
      if (!clientId) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Canva OAuth Client ID not configured.', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets.',
        });
      }
      if (!clientSecret) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Canva OAuth Client Secret not configured.', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets.',
        });
      }

      const accessToken = userSecrets.ACCESS_TOKEN || userSecrets.access_token;
      const refreshToken = userSecrets.REFRESH_TOKEN || userSecrets.refresh_token;
      if (!accessToken || !refreshToken) {
        builder.addIssue('AUTH_REQUIRED', 'Canva account not connected.', {
          type: 'user_action',
          description: 'Connect your Canva account to use this integration.',
        });
      } else {
        try {
          await canvaRequest(context, '/users/me');
        } catch (apiError: any) {
          const msg = apiError?.message ?? 'Canva API error';
          if (msg.includes('401') || msg.toLowerCase().includes('authentication')) {
            builder.addIssue('AUTH_EXPIRED', 'Canva access token expired or revoked.', {
              type: 'user_action',
              description: 'Reconnect your Canva account.',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Canva API error: ${msg}`, {
              type: 'auto_retry',
              description: 'Canva API temporarily unavailable.',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to read secrets.',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and the backend is reachable.',
        },
      );
    }

    return builder.build();
  },
});

// ============================================================================
// REGISTER TOOLS
// ============================================================================

// Users
server.tool('get-user', getUser);
server.tool('get-user-profile', getUserProfile);
server.tool('get-user-capabilities', getUserCapabilities);

// Designs
server.tool('list-designs', listDesigns);
server.tool('get-design', getDesign);
server.tool('create-design', createDesign);
server.tool('get-design-pages', getDesignPages);
server.tool('get-design-export-formats', getDesignExportFormats);

// Exports + Resizes
server.tool('export-design', exportDesign);
server.tool('get-export-job', getExportJob);
server.tool('create-resize-job', createResizeJob);
server.tool('get-resize-job', getResizeJob);

// Imports
server.tool('import-design', importDesign);
server.tool('get-import-job', getImportJob);

// Folders
server.tool('list-folders', listFolders);
server.tool('get-folder', getFolder);
server.tool('create-folder', createFolder);
server.tool('update-folder', updateFolder);
server.tool('delete-folder', deleteFolder);
server.tool('move-item', moveItem);

// Assets
server.tool('upload-asset', uploadAsset);
server.tool('get-asset-upload-job', getAssetUploadJob);
server.tool('get-asset', getAsset);
server.tool('update-asset', updateAsset);
server.tool('delete-asset', deleteAsset);

// Brand templates + autofill
server.tool('list-brand-templates', listBrandTemplates);
server.tool('get-brand-template', getBrandTemplate);
server.tool('get-brand-template-dataset', getBrandTemplateDataset);
server.tool('autofill-design', autofillDesign);
server.tool('get-autofill-job', getAutofillJob);

// Comments (threads + replies)
server.tool('create-thread', createThread);
server.tool('get-thread', getThread);
server.tool('list-replies', listReplies);
server.tool('create-reply', createReply);
server.tool('get-reply', getReply);

// ============================================================================
// START
// ============================================================================

server.start().catch((error) => {
  console.error('[Canva MCA] Fatal error:', error);
  process.exit(1);
});
