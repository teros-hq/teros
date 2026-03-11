#!/usr/bin/env bun

/**
 * Canva MCA v1.0
 *
 * Canva Connect API integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Features:
 * - Design management (list, create, export)
 * - Folder management
 * - Asset uploads
 * - Brand templates and autofill
 * - Design import from external files
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { canvaRequest, initializeCanvaClient } from './lib';
import {
  autofillDesign,
  createDesign,
  createFolder,
  deleteAsset,
  exportDesign,
  getAsset,
  getAssetUploadJob,
  getAutofillJob,
  getBrandTemplate,
  getBrandTemplateDataset,
  getDesign,
  getExportJob,
  getFolder,
  getImportJob,
  getUser,
  getUserProfile,
  importDesign,
  listBrandTemplates,
  listDesigns,
  listFolders,
  moveItem,
  uploadAsset,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.canva',
  name: 'Canva',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity to Canva.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await context.getUserSecrets();

      // Check system secrets
      if (!systemSecrets.CLIENT_ID && !systemSecrets.client_id) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Canva OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        });
      }
      if (!systemSecrets.CLIENT_SECRET && !systemSecrets.client_secret) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Canva OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        });
      }

      // Check user credentials
      const accessToken = userSecrets.ACCESS_TOKEN || userSecrets.access_token;
      const refreshToken = userSecrets.REFRESH_TOKEN || userSecrets.refresh_token;

      if (!accessToken || !refreshToken) {
        builder.addIssue('AUTH_REQUIRED', 'Canva account not connected', {
          type: 'user_action',
          description: 'Connect your Canva account to use this integration',
        });
      } else {
        // Try to validate credentials with a simple API call
        try {
          await initializeCanvaClient(context);
          await canvaRequest(context, '/users/me');
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('Authentication')) {
            builder.addIssue('AUTH_EXPIRED', 'Canva access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Canva account',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Canva API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Canva API temporarily unavailable',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: USER
// =============================================================================

server.tool('get-user', getUser);
server.tool('get-user-profile', getUserProfile);

// =============================================================================
// REGISTER TOOLS: DESIGNS
// =============================================================================

server.tool('list-designs', listDesigns);
server.tool('get-design', getDesign);
server.tool('create-design', createDesign);
server.tool('export-design', exportDesign);
server.tool('get-export-job', getExportJob);

// =============================================================================
// REGISTER TOOLS: FOLDERS
// =============================================================================

server.tool('list-folders', listFolders);
server.tool('get-folder', getFolder);
server.tool('create-folder', createFolder);
server.tool('move-item', moveItem);

// =============================================================================
// REGISTER TOOLS: ASSETS
// =============================================================================

server.tool('upload-asset', uploadAsset);
server.tool('get-asset-upload-job', getAssetUploadJob);
server.tool('get-asset', getAsset);
server.tool('delete-asset', deleteAsset);

// =============================================================================
// REGISTER TOOLS: BRAND TEMPLATES
// =============================================================================

server.tool('list-brand-templates', listBrandTemplates);
server.tool('get-brand-template', getBrandTemplate);
server.tool('get-brand-template-dataset', getBrandTemplateDataset);
server.tool('autofill-design', autofillDesign);
server.tool('get-autofill-job', getAutofillJob);

// =============================================================================
// REGISTER TOOLS: IMPORT
// =============================================================================

server.tool('import-design', importDesign);
server.tool('get-import-job', getImportJob);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Canva MCA] Fatal error:', error);
  process.exit(1);
});
