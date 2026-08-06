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
import { BrowserbaseToolCallRenderer } from './renderers/BrowserbaseRenderer';
import { BashToolCallRenderer } from './renderers/BashRenderer';
import { BrevoToolCallRenderer } from './renderers/BrevoRenderer';
import { BoardToolCallRenderer } from './renderers/BoardRenderer';
import { CalendarToolCallRenderer } from './renderers/CalendarRenderer';
import { CanvaToolCallRenderer } from './renderers/CanvaRenderer';
import { ContactsToolCallRenderer } from './renderers/ContactsRenderer';
import { DriveToolCallRenderer } from './renderers/DriveRenderer';
import { ElevenLabsToolCallRenderer } from './renderers/ElevenLabsRenderer';
import { HunterToolCallRenderer } from './renderers/HunterRenderer';
import { FeedbackToolCallRenderer } from './renderers/FeedbackRenderer';
import { FigmaToolCallRenderer } from './renderers/FigmaRenderer';
// Import MCA UI components
import { FilesystemToolCallRenderer } from './renderers/FilesystemRenderer';
import { GitHubToolCallRenderer } from './renderers/github';
import { GmailToolCallRenderer } from './renderers/GmailRenderer';
import { GoogleAnalyticsToolCallRenderer } from './renderers/GoogleAnalyticsRenderer';
import { HttpToolCallRenderer } from './renderers/HttpRenderer';
import { OutlookToolCallRenderer } from './renderers/OutlookRenderer';
import { LinearToolCallRenderer } from './renderers/LinearRenderer';
import { MakeToolCallRenderer } from './renderers/MakeRenderer';
import { MessagingToolCallRenderer } from './renderers/MessagingRenderer';
import { NetlifyToolCallRenderer } from './renderers/NetlifyRenderer';
import { NotionToolCallRenderer } from './renderers/NotionRenderer';
import { PerplexityToolCallRenderer } from './renderers/PerplexityRenderer';
import { ReplicateToolCallRenderer } from './renderers/ReplicateRenderer';
import { ConversationsToolCallRenderer } from './renderers/ConversationsRenderer';
import { Context7ToolCallRenderer } from './renderers/Context7Renderer';
import { GuideToolCallRenderer } from './renderers/GuideRenderer';
import { RailwayToolCallRenderer } from './renderers/RailwayRenderer';
import { RenderToolCallRenderer } from './renderers/RenderRenderer';
import { RunnToolCallRenderer } from './renderers/RunnRenderer';
import { SchedulerToolCallRenderer } from './renderers/scheduler';
import { SlackToolCallRenderer } from './renderers/SlackRenderer';
import { TerosCoreToolCallRenderer } from './renderers/TerosCoreRenderer';
import { WhatsappToolCallRenderer } from './renderers/WhatsappRenderer';
import { DockerEnvToolCallRenderer } from './renderers/DockerEnvRenderer';
import { ActiveCampaignToolCallRenderer } from './renderers/ActiveCampaignRenderer';

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

  // Register Admin Filesystem MCA (host access, stdio, no jail)
  McaRegistry.register({
    mcaId: 'mca.teros.admin.filesystem',
    name: 'Filesystem (Admin)',
    toolNames: [],
    ToolCallRenderer: FilesystemToolCallRenderer,
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

  // Register Make MCA (Make.com automation: webhooks + scenarios)
  McaRegistry.register({
    mcaId: 'mca.make',
    name: 'Make',
    toolNames: [],
    ToolCallRenderer: MakeToolCallRenderer,
  });

  // Register GitHub MCA (repos, issues, PRs, actions, releases)
  McaRegistry.register({
    mcaId: 'mca.github',
    name: 'GitHub',
    toolNames: [],
    ToolCallRenderer: GitHubToolCallRenderer,
  });

  // Register Google Drive MCA (File storage)
  McaRegistry.register({
    mcaId: 'mca.google.drive',
    name: 'Google Drive',
    toolNames: [],
    ToolCallRenderer: DriveToolCallRenderer,
  });

  // Register Google Calendar MCA (events, attendees, free/busy, recurrence + Meet)
  McaRegistry.register({
    mcaId: 'mca.google.calendar',
    name: 'Google Calendar',
    toolNames: [],
    ToolCallRenderer: CalendarToolCallRenderer,
  });

  // Register Google Analytics MCA (GA4 reports + property/stream admin)
  McaRegistry.register({
    mcaId: 'mca.google.analytics',
    name: 'Google Analytics',
    toolNames: [],
    ToolCallRenderer: GoogleAnalyticsToolCallRenderer,
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

  // Register Hunter MCA (email finder: domain search, email finder, verifier)
  McaRegistry.register({
    mcaId: 'mca.hunter',
    name: 'Hunter',
    toolNames: [],
    ToolCallRenderer: HunterToolCallRenderer,
  });

  // Register Browserbase MCA (cloud browser automation + Live View)
  McaRegistry.register({
    mcaId: 'mca.browserbase',
    name: 'Browserbase',
    toolNames: [],
    ToolCallRenderer: BrowserbaseToolCallRenderer,
  });

  // Register Canva MCA (designs, exports, resizes, comments, brand templates)
  McaRegistry.register({
    mcaId: 'mca.canva',
    name: 'Canva',
    toolNames: [],
    ToolCallRenderer: CanvaToolCallRenderer,
  });

  // Register Brevo MCA (transactional email, contacts, email campaigns)
  McaRegistry.register({
    mcaId: 'mca.brevo',
    name: 'Brevo',
    toolNames: [],
    ToolCallRenderer: BrevoToolCallRenderer,
  });

  // Register Conversations MCA
  McaRegistry.register({
    mcaId: 'mca.teros.conversations',
    name: 'Conversations',
    toolNames: [],
    ToolCallRenderer: ConversationsToolCallRenderer,
  });

  // Register Railway MCA (cloud deployments)
  McaRegistry.register({
    mcaId: 'mca.railway',
    name: 'Railway',
    toolNames: [],
    ToolCallRenderer: RailwayToolCallRenderer,
  });

  // Register Render MCA (cloud deployments)
  McaRegistry.register({
    mcaId: 'mca.render',
    name: 'Render',
    toolNames: [],
    ToolCallRenderer: RenderToolCallRenderer,
  });

  // Register Netlify MCA (static site deploys)
  McaRegistry.register({
    mcaId: 'mca.netlify',
    name: 'Netlify',
    toolNames: [],
    ToolCallRenderer: NetlifyToolCallRenderer,
  });

  // Register Context7 MCA (up-to-date library docs via Upstash Context7)
  McaRegistry.register({
    mcaId: 'mca.context7',
    name: 'Context7',
    toolNames: [],
    ToolCallRenderer: Context7ToolCallRenderer,
  });

  // Register Teros Guide MCA (platform self-knowledge — how to use Teros)
  McaRegistry.register({
    mcaId: 'mca.teros.guide',
    name: 'Teros Guide',
    toolNames: [],
    ToolCallRenderer: GuideToolCallRenderer,
  });

  // Register Teros Core MCA (platform management: agents, workspaces, apps,
  // catalog, providers, skills, access). 100% coverage: 40 dedicated
  // sub-renderers. FallbackRenderer is a dev-only signal of a missing
  // renderer (bug), not a production path.
  //
  // This register call was accidentally removed in commit d1145f92 (2026-04-22,
  // "feat(app/mca): BoardRenderer compartido — 34 sub-renderers + 2 registros")
  // when the Board registers replaced the existing Core block. The
  // TerosCoreToolCallRenderer import stayed alive, but with no register call
  // every `mca.teros.core` tool call fell through to `DefaultToolCallRenderer`
  // in production — losing 40 dedicated sub-renderers. Restored here.
  McaRegistry.register({
    mcaId: 'mca.teros.core',
    name: 'Teros Core',
    toolNames: [],
    ToolCallRenderer: TerosCoreToolCallRenderer,
  });

  // Register Slack MCA (channels, messages, users, files, search)
  McaRegistry.register({
    mcaId: 'mca.slack',
    name: 'Slack',
    toolNames: [],
    ToolCallRenderer: SlackToolCallRenderer,
  });

  // Register Board MCAs (manager + runner share the same renderer — see
  // packages/app/src/components/mca/renderers/BoardRenderer.tsx). The mcaId
  // is the dispatch key, so registering twice points both MCAs at the same
  // component without duplicating sub-renderers.
  McaRegistry.register({
    mcaId: 'mca.teros.board-manager',
    name: 'Board Manager',
    toolNames: [],
    ToolCallRenderer: BoardToolCallRenderer,
  });
  McaRegistry.register({
    mcaId: 'mca.teros.board-runner',
    name: 'Board Runner',
    toolNames: [],
    ToolCallRenderer: BoardToolCallRenderer,
  });

  // Register WhatsApp MCA
  McaRegistry.register({
    mcaId: 'mca.whatsapp',
    name: 'WhatsApp',
    toolNames: [],
    ToolCallRenderer: WhatsappToolCallRenderer,
  });

  // Register Docker Environments MCA
  McaRegistry.register({
    mcaId: 'mca.teros.docker-env',
    name: 'Docker Environments',
    toolNames: [],
    ToolCallRenderer: DockerEnvToolCallRenderer,
  });

  // Register Scheduler MCA (TER-186 audit)
  McaRegistry.register({
    mcaId: 'mca.teros.scheduler',
    name: 'Scheduler',
    toolNames: [],
    ToolCallRenderer: SchedulerToolCallRenderer,
  });

  // Register HTTP Request MCA (generic REST client: http-request + health-check)
  McaRegistry.register({
    mcaId: 'mca.teros.http',
    name: 'HTTP Request',
    toolNames: [],
    ToolCallRenderer: HttpToolCallRenderer,
  });

  // Register ActiveCampaign MCA (CRM + email marketing)
  McaRegistry.register({
    mcaId: 'mca.activecampaign',
    name: 'ActiveCampaign',
    toolNames: [],
    ToolCallRenderer: ActiveCampaignToolCallRenderer,
  });

  // Register Runn MCA (resource management: projects, people, assignments,
  // timesheets, capacity planning). 21/21 coverage — FallbackRenderer is a
  // dev-only signal of a missing sub-renderer.
  McaRegistry.register({
    mcaId: 'mca.runn',
    name: 'Runn',
    toolNames: [],
    ToolCallRenderer: RunnToolCallRenderer,
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
