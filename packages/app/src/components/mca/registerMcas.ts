/**
 * MCA Registration
 *
 * Registers all available MCAs with their UI components.
 * This file is imported at app startup to populate the registry.
 *
 * With the new naming system:
 * - Tool names are prefixed with user-defined app name (e.g., bash_bash, gmail-work_read-email)
 * - Renderer matching is done by mcaId (e.g., mca.teros.bash) which is consistent
 * - No need to list individual tool names anymore
 */

import { McaRegistry } from './McaRegistry';
import { AdminBashToolCallRenderer } from './renderers/AdminBashRenderer';
import { AdminFilesystemToolCallRenderer } from './renderers/AdminFilesystemRenderer';
import { BashToolCallRenderer } from './renderers/BashRenderer';
import { ContactsToolCallRenderer } from './renderers/ContactsRenderer';
import { DriveToolCallRenderer } from './renderers/DriveRenderer';
import { ElevenLabsToolCallRenderer } from './renderers/ElevenLabsRenderer';
import { FeedbackToolCallRenderer } from './renderers/FeedbackRenderer';
import { FigmaToolCallRenderer } from './renderers/FigmaRenderer';
// Import MCA UI components
import { FilesystemToolCallRenderer } from './renderers/FilesystemRenderer';
import { GmailToolCallRenderer } from './renderers/GmailRenderer';
import { OutlookToolCallRenderer } from './renderers/OutlookRenderer';
import { LinearToolCallRenderer } from './renderers/LinearRenderer';
import { MessagingToolCallRenderer } from './renderers/MessagingRenderer';
import { NotionToolCallRenderer } from './renderers/NotionRenderer';
import { PerplexityToolCallRenderer } from './renderers/PerplexityRenderer';
import { ReplicateToolCallRenderer } from './renderers/ReplicateRenderer';

/**
 * Register all MCAs with their UI components
 *
 * Each MCA is registered with its mcaId, which is used to match
 * tool calls to their custom renderers.
 */
export function registerAllMcas(): void {
  // Register Filesystem MCA
  McaRegistry.register({
    mcaId: 'mca.teros.filesystem',
    name: 'Filesystem',
    toolNames: [],
    ToolCallRenderer: FilesystemToolCallRenderer,
  });

  // Register Bash MCA
  McaRegistry.register({
    mcaId: 'mca.teros.bash',
    name: 'Command',
    toolNames: [],
    ToolCallRenderer: BashToolCallRenderer,
  });

  // Register Admin Bash MCA (host access)
  McaRegistry.register({
    mcaId: 'mca.teros.admin.bash',
    name: 'Command (Admin)',
    toolNames: [],
    ToolCallRenderer: AdminBashToolCallRenderer,
  });

  // Register Admin Filesystem MCA (host access)
  McaRegistry.register({
    mcaId: 'mca.teros.admin.filesystem',
    name: 'Filesystem (Admin)',
    toolNames: [],
    ToolCallRenderer: AdminFilesystemToolCallRenderer,
  });

  // Register Messaging MCA (minimal renderer for send-image, send-video, etc.)
  McaRegistry.register({
    mcaId: 'mca.teros.messaging',
    name: 'Messaging',
    toolNames: [],
    ToolCallRenderer: MessagingToolCallRenderer,
  });

  // Register Gmail MCA (Ultra Compact design)
  McaRegistry.register({
    mcaId: 'mca.google.gmail',
    name: 'Gmail',
    toolNames: [],
    ToolCallRenderer: GmailToolCallRenderer,
  });

  // Register Perplexity MCA (AI Search with sources)
  McaRegistry.register({
    mcaId: 'mca.perplexity',
    name: 'Perplexity',
    toolNames: [],
    ToolCallRenderer: PerplexityToolCallRenderer,
  });

  // Register Figma MCA (Design API integration)
  McaRegistry.register({
    mcaId: 'mca.figma',
    name: 'Figma',
    toolNames: [],
    ToolCallRenderer: FigmaToolCallRenderer,
  });

  // Register Linear MCA (Issue tracking)
  McaRegistry.register({
    mcaId: 'mca.linear',
    name: 'Linear',
    toolNames: [],
    ToolCallRenderer: LinearToolCallRenderer,
  });

  // Register Google Drive MCA (File storage)
  McaRegistry.register({
    mcaId: 'mca.google.drive',
    name: 'Google Drive',
    toolNames: [],
    ToolCallRenderer: DriveToolCallRenderer,
  });

  // Register Replicate MCA (AI model execution - FLUX, video generation, etc.)
  McaRegistry.register({
    mcaId: 'mca.replicate',
    name: 'Replicate',
    toolNames: [],
    ToolCallRenderer: ReplicateToolCallRenderer,
  });

  // Register Google Contacts MCA
  McaRegistry.register({
    mcaId: 'mca.google.contacts',
    name: 'Google Contacts',
    toolNames: [],
    ToolCallRenderer: ContactsToolCallRenderer,
  });

  // Register Feedback MCA (User bug reports and suggestions)
  McaRegistry.register({
    mcaId: 'mca.teros.feedback',
    name: 'Feedback',
    toolNames: [],
    ToolCallRenderer: FeedbackToolCallRenderer,
  });

  // Register Notion MCA (Pages, databases, blocks, search, comments)
  McaRegistry.register({
    mcaId: 'mca.notion',
    name: 'Notion',
    toolNames: [],
    ToolCallRenderer: NotionToolCallRenderer,
  });

  // Register Outlook MCA (Email, drafts, folders, rules)
  McaRegistry.register({
    mcaId: 'mca.microsoft.outlook',
    name: 'Outlook',
    toolNames: [],
    ToolCallRenderer: OutlookToolCallRenderer,
  });

  // Register ElevenLabs MCA (Text-to-Speech, voice generation)
  McaRegistry.register({
    mcaId: 'mca.elevenlabs',
    name: 'ElevenLabs',
    toolNames: [],
    ToolCallRenderer: ElevenLabsToolCallRenderer,
  });

  console.log('[registerMcas] All MCAs registered');
}

/**
 * Auto-register on import (for convenience)
 */
let registered = false;

export function ensureMcasRegistered(): void {
  if (!registered) {
    registerAllMcas();
    registered = true;
  }
}
