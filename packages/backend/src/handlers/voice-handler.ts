/**
 * Voice Handler - WebSocket Proxy for ElevenLabs Conversational AI
 *
 * Supports ElevenLabs client tool calling:
 * - Tool: send-message(message, channel-id?)
 *   - Creates or continues a conversation with the Teros agent
 *   - Returns { channel_id } immediately (async)
 *   - When agent finishes, sends tool_result back to ElevenLabs
 * - Tool: list-installed-apps
 *   - Lists all apps installed for the agent (direct + proxy exposure)
 *   - Returns app name, description, tool count, exposure, status
 * - Tool: list-app-tools
 *   - Lists tools of a specific app with permission flags
 *   - Optional `tools` param expands full input schemas
 * - Tool: execute-tool
 *   - Executes a tool of an app via the worker agent (same async pattern as send-message)
 *   - Permissions apply transparently: the worker agent runs the permission gate
 */

import type { Db } from 'mongodb';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { AuthService } from '../auth/auth-service';
import { assertCanCreateChannel } from '../services/channel-authz';
import type { ChannelManager } from '../services/channel-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { SessionManager } from '../services/session-manager';
import type { PubSubService } from '../services/pubsub-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
import type { MessageHandler } from './message-handler';
import type { SessionStore } from '@teros/core';

// =============================================================================
// TYPES
// =============================================================================

interface VoiceConnection {
  clientWs: WebSocket;
  elevenLabsWs: WebSocket | null;
  userId: string;
  workspaceId: string; // workspace context for this voice session — used to scope worker channels
  voiceChannelId: string; // internal channel for voice session (transcript storage fallback)
  chatChannelId: string | null; // chat channel where transcripts are written inline (if provided)
  agentId: string;
  conversationId?: string;
  sessionId: string;
  // Active worker channels delegated via send-message / execute-tool:
  // workerChannelId → subscriptions_channel ids created for it (turn_start + turn_end).
  // The subscriptions route the worker's turn events to the voice channel; they are
  // deleted when the worker finishes or the voice session closes.
  activeWorkerChannels: Map<string, string[]>;
  // Active worker channels already read via get-channel-messages since the last
  // user turn. Allows ONE progress read per user turn ("how's it going?") while
  // blocking tight polling loops. Cleared on every user_transcript.
  channelReadsThisTurn: Set<string>;
  // AF-2: When the worker runs inside the conversation channel (chatChannelId),
  // we temporarily set originChannelId on it to route turn events to the voice
  // channel. This stores the PREVIOUS originChannelId (if any) so cleanup can
  // restore it when the voice session ends — prevents stale voice-channel
  // references from persisting on the conversation channel document.
  savedOriginChannelId?: string | null;
  // AF-4: Silent mode — 'active' (default, agent responds to every turn) or
  // 'silent' (agent transcribes but suppresses spoken responses). Toggled by
  // voice commands "Alice off" / "Alice on" and variants.
  mode: 'active' | 'silent';
  // AF-4: Agent display name — used by the intent classifier for wake-word /
  // direct-address detection (e.g. "Alice, ¿tú cómo lo ves?").
  agentName: string;
  // AF-4: One-shot pass-through flag. When the user directly addresses the
  // agent while in silent mode ("Alice, ...?"), we set this to true for the
  // current turn so the agent_response is allowed through. It resets to false
  // at the start of the next user_transcript turn, returning to silent.
  responsePassThrough: boolean;
  // AF-4: Ack pass-through flag. When entering silent mode ("Alice off"), we
  // set this to true so the ack's agent_response + audio frames pass through
  // the silent-mode suppression. Unlike responsePassThrough, this does NOT
  // affect injectAgentResult — worker results are still suppressed in silent
  // mode even while the ack is playing. Resets to false on the next user_transcript.
  ackPassThrough: boolean;
}

interface ElevenLabsMessage {
  type: string;
  [key: string]: any;
}

// =============================================================================
// VOICE HANDLER
// =============================================================================

export class VoiceHandler {
  private connections: Map<string, VoiceConnection> = new Map();
  private authService: AuthService;
  private pubSubService?: PubSubService;
  private sessionStore?: SessionStore;

  constructor(
    private db: Db,
    private sessionManager: SessionManager,
    private channelManager: ChannelManager,
    private secretsManager: SecretsManager,
    private messageHandler: MessageHandler,
    private mcaEventSubscriptionService: MCAEventSubscriptionService,
    authService?: AuthService,
    private workspaceService: WorkspaceService | null = null,
  ) {
    this.authService = authService ?? new AuthService(db);
  }

  /**
   * Wire in PubSubService so channel listeners use it instead of SessionManager.
   */
  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
  }

  /**
   * Wire in SessionStore so voice transcripts are persisted to the LLM context
   * store (session_messages), not just the display store (channel_messages).
   * Without this, the text agent cannot see what was said during voice mode.
   * AF-5: voice → text context unification.
   */
  setSessionStore(sessionStore: SessionStore): void {
    this.sessionStore = sessionStore;
  }

  // ---------------------------------------------------------------------------
  // VOICE MODE GUARD — used by MessageHandler to prevent duplicate responses
  // ---------------------------------------------------------------------------

  /**
   * Check whether a voice session is active for the given chat channel.
   *
   * When voice mode is active (either 'active' or 'silent'), the text engine
   * (Teros LLM) must NOT process incoming text messages — the voice handler
   * owns the conversation. This prevents duplicate responses:
   *
   * - Voice active mode: ElevenLabs responds, text engine must stay silent.
   * - Voice silent mode: nobody responds, only transcripts are saved.
   * - No voice session: text engine responds normally.
   *
   * @returns The voice mode if active ('active' | 'silent'), or null if no
   *          voice session is bound to this channel.
   */
  isVoiceActiveForChannel(channelId: string): 'active' | 'silent' | null {
    for (const connection of this.connections.values()) {
      if (connection.chatChannelId === channelId) {
        return connection.mode;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // CONNECTION LIFECYCLE
  // ---------------------------------------------------------------------------

  async handleConnection(
    clientWs: WebSocket,
    sessionId: string,
    agentId: string,
    existingChannelId?: string,
    chatChannelId?: string,
  ): Promise<void> {
    const connectionId = this.generateConnectionId();

    try {
      // 1. Authenticate
      const userId = await this.authenticateUser(sessionId);
      if (!userId) {
        this.sendToClient(clientWs, { type: 'error', code: 'auth', message: 'Authentication failed' });
        clientWs.close();
        return;
      }

      console.log(`[VoiceHandler] New connection: ${connectionId} user=${userId} agent=${agentId}${existingChannelId ? ` (resuming ${existingChannelId})` : ''}`);

      // 2. Resolve workspaceId for this voice session.
      //    Priority: chatChannelId workspace > existingChannelId workspace > agent's workspace.
      //    This is needed because the voice agent (Alice) is a superagent (workspaceId=null),
      //    so we must resolve the workspace from the context of the incoming connection.
      let workspaceId: string | undefined;
      if (chatChannelId) {
        const chatChannel = await this.channelManager.getChannel(chatChannelId);
        workspaceId = (chatChannel as any)?.workspaceId || undefined;
      }
      if (!workspaceId && existingChannelId) {
        const existingChannel = await this.channelManager.getChannel(existingChannelId);
        workspaceId = (existingChannel as any)?.workspaceId || undefined;
      }
      if (!workspaceId) {
        // Fall back to the agent's workspaceId (non-superagents)
        const agentDoc = await this.db.collection('agents').findOne({ agentId });
        workspaceId = (agentDoc as any)?.workspaceId || undefined;
      }
      if (!workspaceId) {
        this.sendToClient(clientWs, { type: 'error', code: 'workspace_unresolved', message: 'Could not resolve workspace for voice session' });
        clientWs.close();
        return;
      }
      console.log(`[VoiceHandler] Workspace resolved: ${workspaceId}`);

      // SEC-2 (TER-721 / A2): voice is the third channel-creation entry point.
      // agentId is client-supplied, so without this a member could drive another
      // tenant's private agent over voice. Same gate as channel.create; the catch
      // below turns a denial into an error frame + close.
      await assertCanCreateChannel(this.db, this.workspaceService, userId, workspaceId, agentId);

      // 3. Create or resume voice channel (for transcript storage)
      let voiceChannelId: string;
      let isResuming = false;

      if (existingChannelId) {
        // Try to reuse existing channel
        const existing = await this.channelManager.getChannel(existingChannelId);
        if (existing && (existing as any).userId === userId) {
          voiceChannelId = existingChannelId;
          isResuming = true;
          console.log(`[VoiceHandler] Resuming voice channel: ${voiceChannelId}`);
        } else {
          console.warn(`[VoiceHandler] Channel ${existingChannelId} not found or unauthorized, creating new`);
          const voiceChannel = await this.channelManager.createChannel(
            userId,
            agentId,
            { transport: 'voice', name: 'Voice Conversation' },
            { workspaceId },
          );
          voiceChannelId = voiceChannel.channelId;
        }
      } else {
        const voiceChannel = await this.channelManager.createChannel(
          userId,
          agentId,
          { transport: 'voice', name: 'Voice Conversation' },
          { workspaceId },
        );
        voiceChannelId = voiceChannel.channelId;
      }
      console.log(`[VoiceHandler] Voice channel: ${voiceChannelId}`);

      // 3. Get ElevenLabs signed URL
      const signedUrl = await this.getElevenLabsSignedUrl();

      // 4. Get agent info + user profile for system prompt injection
      const agent = await this.db.collection('agents').findOne({ agentId });
      const agentName = agent?.name || 'Assistant';
      const agentRole = agent?.role || '';
      const user = await this.db.collection('users').findOne({ userId });
      const userName = user?.profile?.displayName || 'the user';
      const userEmail = user?.profile?.email || '';

      // 4b. Load prior context for ElevenLabs prompt injection.
      //   - If resuming a voice channel, load voice transcript history.
      //   - If a chatChannelId is provided (AF-1), load the text conversation context
      //     so ElevenLabs knows what was discussed and which files were read.
      let priorContext = '';
      let historicTranscripts: Array<{ id: string; text: string; isUser: boolean; timestamp: number; type?: string }> = [];
      if (isResuming) {
        priorContext = await this.loadPriorContext(voiceChannelId);
        historicTranscripts = await this.loadHistoricTranscripts(voiceChannelId);
      }
      // AF-1: inject text-conversation context (files, recent messages) into the
      // voice session prompt. This is the core fix for the 3-files test — without
      // it, ElevenLabs has zero knowledge of anything said or read in text mode.
      if (chatChannelId) {
        const chatContext = await this.loadChatContext(chatChannelId);
        if (chatContext) {
          priorContext = priorContext
            ? `${priorContext}\n\n--- Text conversation context ---\n${chatContext}`
            : chatContext;
        }
      }

      // 7. Init connection
      const connection: VoiceConnection = {
        clientWs,
        elevenLabsWs: null,
        userId,
        workspaceId,
        voiceChannelId,
        chatChannelId: chatChannelId || null,
        agentId,
        sessionId,
        activeWorkerChannels: new Map(),
        channelReadsThisTurn: new Set(),
        // AF-4: Silent mode — starts in 'active' (normal responding).
        mode: 'active',
        agentName,
        responsePassThrough: false,
        ackPassThrough: false,
      };
      this.connections.set(connectionId, connection);

      // 6. Connect to ElevenLabs (with prior context if resuming)
      await this.connectToElevenLabs(connectionId, signedUrl, agentName, agentRole, userName, userEmail, priorContext);

      // 7. Setup client message proxy
      this.setupClientHandlers(connectionId);

      // 8. Subscribe to the voice channel for task_update events from worker channels.
      //    This is the persistent listener that replaces the one-shot mechanism in runAgentAndNotify.
      this.setupVoiceChannelListener(connectionId);

      // 9. Notify client of the voice channel ID so it can link to the conversation
      //    Also send historic transcripts so the frontend can hydrate the UI
      this.sendToClient(clientWs, {
        type: 'voice_channel',
        channelId: voiceChannelId,
        isResuming,
        historicTranscripts: historicTranscripts.length > 0 ? historicTranscripts : undefined,
      });

    } catch (error) {
      console.error('[VoiceHandler] Connection error:', error);
      // AF-7: emit typed error code so the client can render a specific message
      const errMsg = (error as Error).message || 'Connection failed';
      let errorCode = 'unknown';
      if (errMsg.toLowerCase().includes('timeout')) {
        errorCode = 'timeout';
      } else if (errMsg.includes('ElevenLabs')) {
        errorCode = 'elevenlabs_signed_url';
      }
      this.sendToClient(clientWs, { type: 'error', code: errorCode, message: errMsg });
      setTimeout(() => {
        clientWs.close();
        this.connections.delete(connectionId);
      }, 100);
    }
  }

  // ---------------------------------------------------------------------------
  // AUTH
  // ---------------------------------------------------------------------------

  private async authenticateUser(sessionId: string): Promise<string | null> {
    try {
      const result = await this.authService.validateSession(sessionId);
      return result.success ? result.user!.userId : null;
    } catch (error) {
      console.error('[VoiceHandler] Auth error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // ELEVENLABS CONNECTION
  // ---------------------------------------------------------------------------

  private async getElevenLabsSignedUrl(): Promise<string> {
    const secrets = this.secretsManager.mca('mca.elevenlabs');
    const apiKey = secrets?.API_KEY;
    const elevenLabsAgentId = secrets?.AGENT_ID;

    if (!apiKey) throw new Error('ElevenLabs API key not configured');
    if (!elevenLabsAgentId) throw new Error('ElevenLabs AGENT_ID not configured');

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${elevenLabsAgentId}`,
      { headers: { 'xi-api-key': apiKey } },
    );
    if (!res.ok) throw new Error(`ElevenLabs signed URL failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return (data as any).signed_url;
  }

  private async connectToElevenLabs(
    connectionId: string,
    signedUrl: string,
    agentName: string,
    agentRole: string,
    userName: string,
    userEmail: string,
    priorContext?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const connection = this.connections.get(connectionId);
      if (!connection) { reject(new Error('Connection not found')); return; }

      const elevenLabsWs = new WebSocket(signedUrl);
      connection.elevenLabsWs = elevenLabsWs;

      elevenLabsWs.on('open', () => {
        console.log(`[VoiceHandler] ElevenLabs connected: ${connectionId}`);

        // Build dynamic system prompt with current time and user info
        const systemPrompt = this.buildSystemPrompt(agentName, agentRole, userName, userEmail, priorContext);

        const conversationConfigOverride = {
          agent: {
            prompt: {
              prompt: systemPrompt,
            },
          },
        };

        // Send conversation initiation with tool definitions and prompt override
        elevenLabsWs.send(JSON.stringify({
          type: 'conversation_initiation_client_data',
          conversation_config_override: conversationConfigOverride,
          client_tools: [
            {
              name: 'send-message',
              description: `Send a message or task to the Teros agent (${agentName}). Use this for anything that requires reasoning, tool use, data retrieval, or taking actions (emails, calendar, tasks, searches, etc.). Returns a channel_id immediately — the result arrives asynchronously. Pass channel_id to continue an existing task.`,
              parameters: {
                type: 'object',
                properties: {
                  message: {
                    type: 'string',
                    description: 'The message or task to send to the agent.',
                  },
                  channel_id: {
                    type: 'string',
                    description: 'Optional. The channel_id from a previous send-message call, to continue that same task.',
                  },
                },
                required: ['message'],
              },
            },
            {
              name: 'get-channel-messages',
              description: `Read the latest messages from an active task channel. Use this when the user asks "how is it going?", "any updates?", "what happened with X?" or similar progress questions about an ongoing or completed task.`,
              parameters: {
                type: 'object',
                properties: {
                  channel_id: {
                    type: 'string',
                    description: 'The channel_id returned by a previous send-message call.',
                  },
                  limit: {
                    type: 'number',
                    description: 'Number of recent messages to return. Default: 5.',
                  },
                },
                required: ['channel_id'],
              },
            },
            {
              name: 'get-user-context',
              description: `Get current context about the user and the active session: user name, current date and time, and the list of active task channels open in this voice session. Call this at the start of a conversation or when you need to know who you are talking to, what time it is, or which tasks are currently running.`,
              parameters: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'list-channels',
              description: `List the user's past conversations with a preview of each. Supports optional query text search and limit. Use this when the user asks about past conversations or wants to revisit a previous topic.`,
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Optional: text to search in channel name or last message preview.',
                  },
                  limit: {
                    type: 'number',
                    description: 'Optional: maximum number of channels to return. Default: 20.',
                  },
                  status: {
                    type: 'string',
                    description: 'Optional: filter by channel status (active, closed).',
                  },
                },
              },
            },
            {
              name: 'list-installed-apps',
              description: `List all apps installed for the agent, with a short description, tool count, exposure (direct or proxy), and live status (ready/standby/error/disabled). Use this to discover what apps are available before calling list-app-tools or execute-tool.`,
              parameters: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'list-app-tools',
              description: `List the tools an installed app provides. By default returns a compact list: tool name, description, and permission flags (allow/ask/forbid). Pass 'tools' with specific tool names to also get their full input schemas — do that before calling execute-tool for a tool whose parameters you do not know.`,
              parameters: {
                type: 'object',
                properties: {
                  app: {
                    type: 'string',
                    description: 'The app name or appId, as returned by list-installed-apps.',
                  },
                  tools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: specific tool names to expand with their full input schemas.',
                  },
                },
                required: ['app'],
              },
            },
            {
              name: 'execute-tool',
              description: `Execute a tool of an installed app by name. Use this for direct, single-tool actions when you know exactly which app and tool to call. For complex tasks that require reasoning or multiple steps, use send-message instead. Permissions apply exactly as if the tool were called directly: the user may be asked to confirm, and forbidden tools stay forbidden. Returns a channel_id immediately — the result arrives asynchronously when the task finishes.`,
              parameters: {
                type: 'object',
                properties: {
                  app: {
                    type: 'string',
                    description: 'The app name or appId, as returned by list-installed-apps.',
                  },
                  tool: {
                    type: 'string',
                    description: 'The tool name within the app, as returned by list-app-tools.',
                  },
                  input: {
                    type: 'object',
                    description: 'The tool input, matching its input schema. Omit for tools without parameters.',
                  },
                },
                required: ['app', 'tool'],
              },
            },
          ],
        }));

        this.setupElevenLabsHandlers(connectionId);
        resolve();
      });

      elevenLabsWs.on('error', (err) => {
        console.error(`[VoiceHandler] ElevenLabs error: ${connectionId}`, err);
        reject(err);
      });

      setTimeout(() => {
        if (elevenLabsWs.readyState !== WebSocket.OPEN) {
          reject(new Error('ElevenLabs connection timeout'));
        }
      }, 10000);
    });
  }

  private buildSystemPrompt(agentName: string, agentRole: string, userName: string, userEmail: string, priorContext?: string): string {
    const role = agentRole ? `, ${agentRole}` : '';
    const now = new Date().toISOString();
    const userLine = userName ? `\nUser: ${userName}${userEmail ? ` (${userEmail})` : ''}` : '';
    const priorContextSection = priorContext
      ? `\n\nPREVIOUS CONVERSATION CONTEXT (session resumed):\n${priorContext}\n\n[End of previous context. Continue naturally from where you left off.]`
      : '';

    return `You are ${agentName}${role}, the personal voice assistant of ${userName || 'the user'}. Behave like a natural, friendly human assistant.

CURRENT CONTEXT (at session start):
- Date and time: ${now}${userLine}${priorContextSection}

YOUR TOOLS:
You have access to 7 tools:

Core tools:
1. send-message — delegate a COMPLEX task to the Teros agent, which has access to everything (code, git, emails, calendar, files, web, etc.). For simple actions, prefer execute-tool yourself.
2. get-channel-messages — read the current state of an ongoing task by channel-id
3. get-user-context — get live info: current time, user name, active tasks
4. list-channels — list the user's past conversations with a preview of each

Tool execution proxy:
5. list-installed-apps — discover what apps are installed for you (name, description, tool count, exposure, status)
6. list-app-tools — list the tools of a specific app, with permission flags and optional full input schemas
7. execute-tool — execute a specific tool of a specific app directly. Use this for single, well-defined actions when you know exactly which app and tool to call. Returns a channel-id immediately; the result arrives asynchronously.

You cannot access emails, calendars, code, files, or the internet by any other means: everything goes through execute-tool (simple actions you resolve yourself) or send-message (complex tasks you delegate).

HOW TO HANDLE REQUESTS:

- Casual conversation or greetings: respond directly, no tool needed.

- SIMPLE requests — anything you can resolve with a handful of tool calls (search emails, read a specific email, list calendar events, list tasks, send a simple message, look something up in an app): resolve it YOURSELF with execute-tool. This is your default. Chain up to 3-4 calls if needed (e.g. search first, then fetch the top result by the id the search returned). Discovery is part of the same uninterrupted chain: say one short phrase, then call list-installed-apps → list-app-tools → execute-tool back to back, WITHOUT speaking between the calls. Do not stop after a list call to narrate what you found — the chain is not done until execute-tool has been called. Only call tools that list-app-tools actually returned, with parameters matching their input schema. Ids MUST be copied verbatim from a previous tool result — NEVER invent them, never use list positions ("1", "2"), never channel ids. If a result did not include the id you need, redo the search and take the id from there.

- COMPLEX requests — anything needing multi-step reasoning, judgment, or work across apps (code and git, writing or replying to emails with real content, research, comparing options, workflows like "organize my week", anything ambiguous): delegate with send-message IMMEDIATELY — do not ask for confirmation, do not explain what you are about to do. Say one short phrase while the task runs, then wait for the result. When the result arrives, summarize it conversationally.

- Rule of thumb: if you can name the exact tool calls needed, do it yourself with execute-tool. If you would have to figure things out along the way, delegate with send-message.

- Progress questions ("how is it going?", "any updates?"): call get-channel-messages with the relevant channel-id.

- Questions about time, date, or active tasks: call get-user-context.

- Questions about past conversations: call list-channels, then get-channel-messages if the user wants details.

MANAGING MULTIPLE TASKS:
- Each send-message or execute-tool call returns a channel-id. Remember it — each one is an independent task.
- Results arrive automatically when the task finishes. No need to poll.
- If the user asks about a specific task, use get-channel-messages with that task's channel-id.

<examples>
Example 1 — Git / code:
User: "Do we have everything committed in the repository?"
You (spoken): "Give me a second."
You (tool call): send-message("Please check the current state of the git repository: show recent commits, any uncommitted changes, and the current branch.")

Example 2 — Email (simple → execute-tool yourself):
User: "Do I have any urgent emails?"
You (spoken): "Let me check."
You (tool call): list-installed-apps()
You (tool call): list-app-tools(app="gmail")
You (tool call): execute-tool(app="gmail", tool="search-messages", input={"query": "is:unread", "maxResults": 10})
[SILENCE until the result arrives, then summarize the important ones]

Example 3 — Task status:
User: "How is that task going?"
You (tool call): get-channel-messages(channel-id="ch_xxx")
You (spoken): summarize what the messages say.

Example 4 — Past conversation:
User: "What did we talk about yesterday regarding the voice feature?"
You (tool call): list-channels(query="voice")
You (tool call): get-channel-messages(channel-id="ch_yyy")
You (spoken): summarize the relevant content.

Example 5 — Simple lookup (execute-tool yourself):
User: "What's on my calendar today?"
You (spoken): "One moment."
You (tool call): list-installed-apps()
You (tool call): list-app-tools(app="google-calendar")
You (tool call): execute-tool(app="google-calendar", tool="list-events", input={...today's range...})
[SILENCE until the result arrives, then summarize]

Example 6 — Chained simple calls (ids come from previous results):
User: "Read me the last email from Ana."
You (spoken): "Checking now."
You (tool call): execute-tool(app="gmail", tool="search-messages", input={"query": "from:Ana", "maxResults": 1})
[result arrives with the message id]
You (tool call): execute-tool(app="gmail", tool="get-message", input={"id": "<id from the search result>"})
[SILENCE until the result arrives, then read it conversationally]

Example 7 — Complex task (delegate):
User: "Reply to Ana's email telling her the report will be ready on Friday, in a friendly tone."
You (spoken): "On it."
You (tool call): send-message("Find the latest email from Ana and reply telling her the report will be ready on Friday, friendly tone.")
</examples>

STYLE:
- Talk like a human, not a robot.
- Be concise. Short answers. Max 2-3 sentences unless listing items.
- NEVER expose internal mechanics to the user. No IDs (channel, message, tool call), no tool or app names, no schemas, no "I need the exact ID", no "let me search again to get the right parameter". That is plumbing — the user must never hear it. If you need another lookup to complete something, just do it silently and only speak when you have something meaningful for them ("Aquí está el correo de Ana...").
- If something fails internally, do not explain the technical reason. Say something natural ("No lo encuentro todavía, dame un segundo") while you retry a different way.
- Speak in the user's terms: emails, meetings, tasks, files — never workers, channels, tools, queries or parameters.
- Never end with open-ended questions like "Is there anything else?". Close naturally.
- Never explain that you are delegating.

TOOL DISCIPLINE:
- NEVER say you are doing something without actually doing it. If you say "I'm searching" or "let me check", the tool call MUST happen in that same turn, immediately. Announcing an action and then waiting is lying to the user — it is the worst failure mode you have.
- Once you call send-message or execute-tool, do NOT call it again for the same request. The result will arrive on its own.
- While waiting, say ONE brief phrase BEFORE calling the tool — then stop talking. Do not keep chatting while the task runs, and do not repeat variations of "one moment".
- Only call send-message again if the user explicitly changes or corrects the request.

CRITICAL — ASYNC TOOL RESULTS:
When send-message or execute-tool returns a tool_result with { "status": "processing" }, this means the task has been queued and is running in the background. YOU MUST:
1. Say NOTHING in response to this tool_result. Do not acknowledge it. Do not say "I'm working on it", "I'm processing", "Let me handle that", or anything similar.
2. Stay completely silent and wait.
3. Only speak again when you receive the [event] agent_response_ready signal — that is when the actual result has arrived and you should summarize it for the user.

The pattern is: speak ONE phrase → call send-message or execute-tool → SILENCE → wait for agent_response_ready → summarize result.
Never produce two verbal responses for the same request. The brief phrase before the tool call and the final summary are the only two moments you speak.

PERMISSION REQUESTS:
When you receive [event] permission_required channel_id=<id> tool=<tool> channel_name=<name>, it means the agent working on that task needs the user to approve an action before it can continue. Tell the user naturally: "The agent needs your approval to use <tool>. You can approve it in the <name> conversation." Do not call any tool — just inform the user.

SILENT MODE (server-enforced):
The user can put you in "silent mode" by saying "${agentName} off" (or variants like "${agentName}, apágate", "${agentName} silencio"). In silent mode:
- You will NOT hear the user's speech as turns — the server suppresses your responses automatically.
- The server still transcribes everything the user says and injects it into your context silently (you may see [overheard while in silent mode] lines).
- The user can directly address you by starting their utterance with your name ("${agentName}, ¿tú cómo lo ves?") — this breaks the silence for ONE turn and you should respond normally.
- After responding to a direct address, you automatically return to silent mode.
- To exit silent mode, the user says "${agentName} on" (or "${agentName}, vuelve", "${agentName} escucha").
- When you receive a [system_ack] message, it is a scripted acknowledgement — just speak it naturally, do not elaborate.

IMPORTANT: Silent mode enforcement is SERVER-SIDE. You do not control it. If the server has suppressed your response, you will simply not be asked to speak. Do not announce that you are in silent mode or explain the mechanism — just cooperate naturally.`;
  }

  // ---------------------------------------------------------------------------
  // CLIENT HANDLERS (mic audio → ElevenLabs proxy)
  // ---------------------------------------------------------------------------

  private setupClientHandlers(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { clientWs, elevenLabsWs } = connection;

    clientWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'user_audio_chunk' && !msg.user_audio_chunk) {
          console.log(`[VoiceHandler] Client → ElevenLabs: ${msg.type || 'audio_chunk'}`);
        }
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(data.toString()); // forward as string (all client messages are JSON)
        }
      } catch { /* intentional: non-JSON from client is a no-op — forward raw data or discard */ }
    });

    clientWs.on('close', () => {
      console.log(`[VoiceHandler] Client disconnected: ${connectionId}`);
      this.cleanup(connectionId);
    });

    clientWs.on('error', (err) => {
      console.error(`[VoiceHandler] Client error: ${connectionId}`, err);
      this.cleanup(connectionId);
    });
  }

  // ---------------------------------------------------------------------------
  // SILENT MODE — intent classification & enforcement (AF-4)
  // ---------------------------------------------------------------------------

  /**
   * Lightweight intent classifier for silent mode control phrases and
   * direct-address detection. Runs on every user_transcript — no LLM call,
   * pure string matching against known command patterns.
   *
   * Detection rules:
   * - Control phrases: "Alice off", "Alice on" + locale variants (es/en).
   *   The agent name is configurable (connection.agentName), so "Alice" can
   *   be replaced by whatever the agent is called.
   * - Direct address: the agent name appears at the START of the utterance
   *   (vocative pattern: "Alice, ..." or "Alice ...") AND the utterance is
   *   NOT a control phrase. Third-person mentions ("le dije a Alice que...")
   *   do NOT match because the name is not at the start.
   *
   * Returns the classified intent so the caller can take the right action.
   */
  private classifyIntent(
    transcript: string,
    agentName: string,
  ): { type: 'silence' | 'activate' | 'direct_address' | 'normal'; raw: string } {
    const text = transcript.trim();
    if (!text) return { type: 'normal', raw: text };

    // Normalise: lowercase, collapse whitespace, strip leading punctuation.
    // We strip ALL non-letter characters (keeping accented letters and ñ)
    // before matching — voice transcriptions often include ¡, ¿, !, ?, ., etc.
    // that would break exact-match against wake-word patterns.
    const lower = text.toLowerCase()
      .replace(/[^a-záéíóúñü\s]/gi, ' ')   // keep letters (incl. accents/ñ) + spaces
      .replace(/\s+/g, ' ')
      .trim();

    // Build the wake word from the agent name (first name, lowercased).
    // "Alice Solana" → "alice"; fallback to full name if single word.
    const wakeWord = (agentName || 'Alice').split(/\s+/)[0].toLowerCase();

    // --- Control phrases: silence (Alice off) ---
    // Matches: "alice off", "alice, apágate", "alice modo silencio",
    //          "alice silencio", "alice cállate", "alice shut up",
    //          "alice stop listening", "alice sleep"
    const silencePatterns = [
      // English
      `${wakeWord} off`,
      `${wakeWord} sleep`,
      `${wakeWord} stop listening`,
      `${wakeWord} be quiet`,
      `${wakeWord} shut up`,
      `${wakeWord} silent mode`,
      `${wakeWord} silence mode`,
      // Spanish
      `${wakeWord} apágate`,
      `${wakeWord} apagate`,
      `${wakeWord} silencio`,
      `${wakeWord} modo silencio`,
      `${wakeWord} modo silencio`,
      `${wakeWord} cállate`,
      `${wakeWord} callate`,
      `${wakeWord} deja de escuchar`,
    ];
    // Match exact or "pattern + trailing words" (e.g. "alice off please").
    // `lower` is already stripped of punctuation, so no separate commaless
    // variant is needed.
    const silencePatternSet = new Set(silencePatterns);
    if (silencePatternSet.has(lower)) {
      return { type: 'silence', raw: text };
    }
    for (const p of silencePatterns) {
      if (lower.startsWith(p + ' ')) {
        return { type: 'silence', raw: text };
      }
    }

    // --- Control phrases: activate (Alice on) ---
    // Matches: "alice on", "alice, vuelve", "alice escucha",
    //          "alice wake up", "alice start listening"
    const activatePatterns = [
      // English
      `${wakeWord} on`,
      `${wakeWord} wake up`,
      `${wakeWord} start listening`,
      `${wakeWord} come back`,
      `${wakeWord} resume`,
      // Spanish
      `${wakeWord} vuelve`,
      `${wakeWord} escucha`,
      `${wakeWord} despierta`,
      `${wakeWord} activa`,
      `${wakeWord} ya puedes hablar`,
    ];
    const activatePatternSet = new Set(activatePatterns);
    if (activatePatternSet.has(lower)) {
      return { type: 'activate', raw: text };
    }
    for (const p of activatePatterns) {
      if (lower.startsWith(p + ' ')) {
        return { type: 'activate', raw: text };
      }
    }

    // --- Direct address: agent name at the start of the utterance ---
    // "Alice, ¿tú cómo lo ves?" → direct_address
    // "Le dije a Alice que..." → NOT direct_address (name not at start)
    // "Alice está haciendo..." → NOT direct_address (third person, no vocative)
    //
    // Heuristic: the utterance starts with the wake word followed by a space
    // (vocative pattern). Punctuation was already stripped by the normalisation
    // above, so "Alice, ..." and "Alice ..." both become "alice ...".
    // We exclude third-person patterns to avoid false positives.
    if (lower.startsWith(wakeWord + ' ')) {
      // Exclude third-person patterns: "alice is...", "alice was...",
      // "alice has...", "alice está...", "alice era...", "alice dice..."
      // These indicate the user is talking ABOUT the agent, not TO the agent.
      const afterWake = lower.substring(wakeWord.length).trim();
      const thirdPersonMarkers = [
        'is ', 'was ', 'has ', 'had ', 'will ', 'should ', 'would ',
        'está ', 'esta ', 'era ', 'es ', 'fue ', 'ha ', 'dice ', 'dijo ',
        'va a ', 'puede ', 'podía ', 'estaba ',
      ];
      const isThirdPerson = thirdPersonMarkers.some(m => afterWake.startsWith(m));
      if (!isThirdPerson && afterWake.length > 0) {
        return { type: 'direct_address', raw: text };
      }
    }

    return { type: 'normal', raw: text };
  }

  /**
   * Send a short spoken acknowledgement to the user via ElevenLabs.
   * Uses the `user_message` injection mechanism — ElevenLabs will verbalize
   * the text as if the agent said it.
   *
   * @param connection The voice connection
   * @param text The acknowledgement text to speak
   */
  private sendVoiceAck(connection: VoiceConnection, text: string): void {
    if (connection.elevenLabsWs?.readyState !== WebSocket.OPEN) return;
    // AF-4: When in silent mode, set ackPassThrough so the ack's agent_response
    // and audio frames bypass the silent-mode suppression. Without this, the
    // enforcement logic (mode==='silent' && !passThrough) would drop the ack
    // audio — the user wouldn't hear "Vale" confirming silent mode activation.
    // The flag resets at the start of the next user_transcript turn.
    if (connection.mode === 'silent') {
      connection.ackPassThrough = true;
      console.log(`[VoiceHandler] Ack pass-through enabled for silent-mode ack`);
    }
    // Send as a user_message so ElevenLabs processes it and speaks it.
    // We use a special prefix so the system prompt instructions can recognize
    // this as a scripted ack and not a user request.
    connection.elevenLabsWs.send(JSON.stringify({
      type: 'user_message',
      text: `[system_ack] ${text}`,
    }));
    // Also notify the frontend client so it can show a visual indicator
    this.sendToClient(connection.clientWs, {
      type: 'voice_ack',
      text,
    });
  }

  /**
   * Inject overheard speech into ElevenLabs context WITHOUT triggering a
   * spoken response. Uses `contextual_update` (silent, non-speaking injection,
   * same mechanism as voice-handler.ts:1680-1683).
   *
   * This keeps the agent's context updated with what the user is saying while
   * in silent mode, so when the user directly addresses the agent later, it
   * has the full context of what was said.
   */
  private injectSilentContext(connection: VoiceConnection, transcript: string): void {
    if (connection.elevenLabsWs?.readyState !== WebSocket.OPEN) return;
    const truncated = transcript.length > 500 ? `${transcript.substring(0, 500)}…` : transcript;
    connection.elevenLabsWs.send(JSON.stringify({
      type: 'contextual_update',
      text: `[overheard while in silent mode] User said: ${truncated}`,
    }));
  }

  /**
   * Notify the frontend client of a mode change so it can update the UI
   * (show a "silent" indicator, etc.).
   */
  private notifyModeChange(connection: VoiceConnection): void {
    this.sendToClient(connection.clientWs, {
      type: 'voice_mode_change',
      mode: connection.mode,
    });
  }

  // ---------------------------------------------------------------------------
  // ELEVENLABS HANDLERS
  // ---------------------------------------------------------------------------

  private setupElevenLabsHandlers(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { clientWs, elevenLabsWs } = connection;
    if (!elevenLabsWs) return;

    elevenLabsWs.on('message', async (data: Buffer) => {
      try {
        const message: ElevenLabsMessage = JSON.parse(data.toString());

        if (message.type !== 'audio') {
          console.log(`[VoiceHandler] ElevenLabs → client: ${message.type}`);
        }

        // Handle tool calls before forwarding
        if (message.type === 'client_tool_call') {
          await this.handleToolCall(connectionId, message);
          // Don't forward tool_call to browser client
          return;
        }

        // Handle metadata
        if (message.type === 'conversation_initiation_metadata') {
          connection.conversationId = message.conversation_initiation_metadata_event?.conversation_id;
          console.log(`[VoiceHandler] ElevenLabs conversation: ${connection.conversationId}`);
        }

        // Save transcripts — pass connection so saveTranscript can route to chatChannelId if set
        if (message.type === 'user_transcript') {
          // New user turn — re-arm the one-progress-read-per-turn allowance
          connection.channelReadsThisTurn.clear();
          // AF-4: Reset one-shot pass-through flags from the previous turn.
          // Both responsePassThrough (direct address) and ackPassThrough (mode
          // change ack) are consumed by the previous turn's response+audio.
          // Resetting here (rather than on agent_response) ensures audio frames
          // arriving after agent_response are still forwarded — the old reset
          // on agent_response cleared pass-through before audio arrived.
          connection.responsePassThrough = false;
          connection.ackPassThrough = false;
          const userText = message.user_transcription_event?.user_transcript || '';

          // AF-4: Silent mode — classify intent on every user transcript.
          // This is the server-side enforcement point. The intent classifier
          // detects control phrases ("Alice off/on") and direct address
          // ("Alice, ¿tú cómo lo ves?"). Actions:
          //   - 'silence'     → set mode='silent', send short ack
          //   - 'activate'    → set mode='active', send short ack
          //   - 'direct_address' → allow ONE response through (pass-through),
          //                        don't change the mode
          //   - 'normal'      → if silent, inject context silently and suppress
          const intent = this.classifyIntent(userText, connection.agentName);

          if (intent.type === 'silence') {
            if (connection.mode !== 'silent') {
              connection.mode = 'silent';
              console.log(`[VoiceHandler] Silent mode ACTIVATED for ${connectionId}`);
              // sendVoiceAck sets ackPassThrough=true so the ack audio passes
              // through the silent-mode suppression.
              this.sendVoiceAck(connection, 'Vale');
              this.notifyModeChange(connection);
            }
            // Idempotent: if already silent, no repeated ack (spec §4.5)
          } else if (intent.type === 'activate') {
            if (connection.mode !== 'active') {
              connection.mode = 'active';
              console.log(`[VoiceHandler] Silent mode DEACTIVATED for ${connectionId}`);
              this.sendVoiceAck(connection, 'Te escucho');
              this.notifyModeChange(connection);
            }
            // Idempotent: if already active, no repeated ack
          } else if (intent.type === 'direct_address') {
            // Direct address while silent → allow this ONE response through.
            // The mode stays 'silent'; after the response, we reset pass-through.
            if (connection.mode === 'silent') {
              connection.responsePassThrough = true;
              console.log(`[VoiceHandler] Direct address detected in silent mode — pass-through enabled for ${connectionId}`);
            }
            // In active mode, direct_address is just a normal turn — no special action.
          } else {
            // Normal speech in silent mode → inject as silent context, no response.
            if (connection.mode === 'silent') {
              this.injectSilentContext(connection, userText);
              console.log(`[VoiceHandler] Silent mode: suppressed response, injected context for ${connectionId}`);
            }
          }

          // Always save the transcript (context accumulation works in both modes)
          this.saveTranscript(connection.voiceChannelId, userText, true, connection).catch((err) => {
            console.error('[VoiceHandler] Failed to save user transcript:', err);
          });
        }
        if (message.type === 'agent_response') {
          const agentText = message.agent_response_event?.agent_response || '';

          // AF-4: In silent mode, suppress the agent response unless a pass-through
          // flag is set. responsePassThrough covers direct-address turns; ackPassThrough
          // covers mode-change acks ("Vale" / "Te escucho"). Both flags reset at the
          // start of the next user_transcript turn (not here) so that audio frames
          // arriving after agent_response are still forwarded to the client.
          if (connection.mode === 'silent' && !connection.responsePassThrough && !connection.ackPassThrough) {
            // Save the transcript but don't forward audio/response to client
            this.saveTranscript(connection.voiceChannelId, agentText, false, connection).catch((err) => {
              console.error('[VoiceHandler] Failed to save agent response transcript:', err);
            });
            // Don't forward — return early so no audio reaches the client
            return;
          }

          // Pass-through or active mode: save and forward normally
          this.saveTranscript(connection.voiceChannelId, agentText, false, connection).catch((err) => {
            console.error('[VoiceHandler] Failed to save agent response transcript:', err);
          });

          // Note: pass-through flags are NOT reset here. They reset at the start
          // of the next user_transcript turn, which ensures audio frames (arriving
          // after agent_response) are still forwarded.
        }

        // AF-4: In silent mode, suppress audio frames (the spoken response).
        // Audio frames arrive after agent_response — if we're in silent mode
        // without any pass-through flag, drop them so the user hears nothing.
        if (message.type === 'audio' && connection.mode === 'silent' && !connection.responsePassThrough && !connection.ackPassThrough) {
          return; // Drop audio — don't forward to client
        }

        // Forward to browser — audio as raw Buffer, everything else as JSON string
        if (clientWs.readyState === WebSocket.OPEN) {
          if (message.type === 'audio') {
            clientWs.send(data); // raw Buffer for audio
          } else {
            clientWs.send(JSON.stringify(message)); // string for JSON messages
          }
        }
      } catch (error) {
        console.error(`[VoiceHandler] Error handling ElevenLabs message: ${connectionId}`, error);
      }
    });

    elevenLabsWs.on('close', (code, reason) => {
      console.log(`[VoiceHandler] ElevenLabs disconnected: ${connectionId} code=${code} reason=${reason?.toString()?.substring(0, 500)}`);
      this.cleanup(connectionId);
    });

    elevenLabsWs.on('error', (err) => {
      console.error(`[VoiceHandler] ElevenLabs error: ${connectionId}`, err);
      this.cleanup(connectionId);
    });
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: send-message
  // ---------------------------------------------------------------------------

  private async handleToolCall(connectionId: string, message: ElevenLabsMessage): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const toolCallId: string = message.tool_call_id || message.client_tool_call?.tool_call_id;
    const toolName: string = message.tool_name || message.client_tool_call?.tool_name;
    const parameters = message.parameters || message.client_tool_call?.parameters || {};

    console.log(`[VoiceHandler] Tool call: ${toolName} (${toolCallId})`);

    if (toolName === 'get-channel-messages') {
      // Client notification happens inside handleGetChannelMessages — polls of
      // still-running workers are refused and must not spam the VoiceWindow.
      await this.handleGetChannelMessages(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName === 'get-user-context') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'get-user-context',
        parameters: {},
      });
      await this.handleGetUserContext(connectionId, toolCallId);
      return;
    }

    if (toolName === 'list-channels') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'list-channels',
        parameters: { query: parameters.query, limit: parameters.limit },
      });
      await this.handleListChannels(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName === 'list-installed-apps') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'list-installed-apps',
        parameters: {},
      });
      await this.handleListInstalledApps(connectionId, toolCallId);
      return;
    }

    if (toolName === 'list-app-tools') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'list-app-tools',
        parameters: { app: parameters.app, tools: parameters.tools },
      });
      await this.handleListAppTools(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName === 'execute-tool') {
      // Client notification happens inside handleExecuteTool (it includes the worker channelId)
      await this.handleExecuteTool(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName !== 'send-message') {
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: `Unknown tool: ${toolName}` }), true);
      return;
    }

    const { message: userMessage, channel_id: existingChannelId } = parameters;

    try {
      // AF-2: When a chatChannelId is linked, run the worker IN the conversation channel
      // so it inherits the full conversation history (files read, prior messages, tool results)
      // naturally via the session store. This is the spec's preferred option (§2.3.2):
      // "ejecutar el worker DENTRO del canal de conversación (turno headless)".
      //
      // If no chatChannelId, fall back to the original behavior: create a headless worker channel.
      let workerChannelId: string;
      const existing = existingChannelId ? await this.channelManager.getChannel(existingChannelId) : null;
      if (existing) {
        workerChannelId = existingChannelId;
        await this.linkWorkerOriginToVoice(connection, workerChannelId);
      } else if (connection.chatChannelId) {
        // Run the worker in the conversation channel — it has the full history.
        workerChannelId = connection.chatChannelId;
        // Point originChannelId at the voice channel so turn events route correctly,
        // and stamp conversationChannelId for traceability (AF-2).
        await this.linkWorkerOriginToVoice(connection, workerChannelId);
        console.log(`[VoiceHandler] send-message → running worker in conversation channel ${workerChannelId} (AF-2 fix)`);
      } else {
        workerChannelId = await this.createAgentChannel(connection.userId, connection.agentId, connection.voiceChannelId, connection.workspaceId);
      }

      console.log(`[VoiceHandler] send-message → worker ${workerChannelId}: "${userMessage.substring(0, 80)}..."`);

      // Route the worker's turn events to this voice channel
      await this.registerWorkerChannel(connection, workerChannelId);

      // Notify frontend of the tool call so it shows in the VoiceWindow
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'send-message',
        message: userMessage,
        channelId: workerChannelId,
      });

      // Respond immediately with channel_id (async pattern)
      // ElevenLabs gets the channel_id right away; the actual result arrives via the
      // voice channel listener when the worker agent finishes its turn.
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        channel_id: workerChannelId,
        status: 'processing',
      }), false);

      // Save tool call transcript — AF-5: now also persists to chat channel via connection
      this.saveTranscript(
        connection.voiceChannelId,
        `🛠️ send-message → [${workerChannelId}]\n"${userMessage}"`,
        true,
        connection,
      ).catch((err) => {
        console.error('[VoiceHandler] Failed to save tool call transcript:', err);
      });

      // Launch agent — fire and forget, response arrives via setupVoiceChannelListener
      await this.runAgentAsync(connectionId, workerChannelId, userMessage);

    } catch (error) {
      console.error(`[VoiceHandler] Tool call error:`, error);
      // intentional: already inside an error handler — transcript failure must not shadow the original error
      await this.saveTranscript(
        connection.voiceChannelId,
        `❌ Error en tool call: ${(error as Error).message}`,
        false,
        connection,
      ).catch((transcriptErr) => {
        console.error('[VoiceHandler] Failed to save tool call error transcript:', transcriptErr);
      });
      this.sendToClient(connection.clientWs, {
        type: 'tool_error',
        error: (error as Error).message,
      });
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (error as Error).message }), true);
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: get-channel-messages
  // ---------------------------------------------------------------------------

  private async handleGetChannelMessages(
    connectionId: string,
    toolCallId: string,
    parameters: Record<string, any>,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const channelId = parameters.channel_id as string;
    const limit = Math.min((parameters.limit as number) || 5, 20);

    if (!channelId) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: 'channel_id is required' }), true, 'get-channel-messages');
      return;
    }

    // Poll backstop: while a tracked worker is running, allow ONE progress read
    // per user turn (legit "how's it going?") and refuse repeats — feeding every
    // read only trains the voice LLM to poll in a tight loop (and spams the UI).
    // Refusals send no toolName → nothing is shown in the VoiceWindow.
    const isActive = connection.activeWorkerChannels.has(channelId);
    if (isActive) {
      if (connection.channelReadsThisTurn.has(channelId)) {
        this.sendToolResult(connection, toolCallId, JSON.stringify({
          channel_id: channelId,
          status: 'processing',
          message: 'Task still running and already checked this turn. The result will arrive automatically as [event] agent_response_ready. Wait in SILENCE — do not call this tool again for this channel.',
        }), false);
        return;
      }
      connection.channelReadsThisTurn.add(channelId);
    }

    try {
      const messages = await this.db.collection('channel_messages')
        .find(
          { channelId, role: { $in: ['user', 'assistant'] }, 'content.type': 'text' },
          { sort: { timestamp: -1 }, limit },
        )
        .toArray();

      // Return in chronological order, most recent last
      const result = messages.reverse().map((m: any) => ({
        role: m.role,
        text: (m.content?.text || '').substring(0, 500),
        timestamp: m.timestamp,
      }));

      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'get-channel-messages',
        parameters: { channel_id: channelId, limit },
      });

      console.log(`[VoiceHandler] get-channel-messages: ${channelId} → ${result.length} messages`);
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        channel_id: channelId,
        status: isActive ? 'processing' : 'completed',
        message_count: result.length,
        messages: result,
      }), false, 'get-channel-messages');
    } catch (err) {
      console.error(`[VoiceHandler] get-channel-messages error:`, err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (err as Error).message }), true, 'get-channel-messages');
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: get-user-context
  // ---------------------------------------------------------------------------

  private async handleGetUserContext(
    connectionId: string,
    toolCallId: string,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    try {
      const user = await this.db.collection('users').findOne({ userId: connection.userId });
      const userName = user?.profile?.displayName || 'Unknown';
      const userEmail = user?.profile?.email || '';

      // Build active tasks list from worker channels
      const activeTasks = Array.from(connection.activeWorkerChannels.entries()).map(([channelId]) => ({
        channel_id: channelId,
        status: 'processing',
      }));

      // AF-6: Include a summary of the linked chat conversation so the voice agent
      // has context about what was discussed and which files were read in text mode.
      let chatContext: { channel_id: string; recent_messages: Array<{ role: string; text: string }>; files_in_context: string[] } | undefined;
      if (connection.chatChannelId) {
        const contextStr = await this.loadChatContext(connection.chatChannelId);
        if (contextStr) {
          // Parse the compact context back into structured form for the tool result
          const recentMessages: Array<{ role: string; text: string }> = [];
          const filesInContext: string[] = [];

          // Extract file paths from the context string
          const fileMatches = contextStr.match(/\/(?:workspace|opt\/teros)\/[^\s]+/g);
          if (fileMatches) {
            for (const fp of fileMatches) {
              if (!filesInContext.includes(fp)) filesInContext.push(fp);
            }
          }

          // Extract conversation lines
          const lines = contextStr.split('\n').filter(l =>
            l.startsWith('User: ') || l.startsWith('Assistant: ')
          );
          for (const line of lines.slice(-10)) {
            const match = line.match(/^(User|Assistant): (.+)$/);
            if (match) {
              recentMessages.push({ role: match[1].toLowerCase(), text: match[2] });
            }
          }

          chatContext = {
            channel_id: connection.chatChannelId,
            recent_messages: recentMessages,
            files_in_context: filesInContext,
          };
        }
      }

      const result = {
        user: {
          name: userName,
          email: userEmail,
        },
        current_time: new Date().toISOString(),
        voice_channel_id: connection.voiceChannelId,
        chat_channel_id: connection.chatChannelId,
        chat_context: chatContext,
        active_tasks: activeTasks,
        active_task_count: activeTasks.length,
      };

      console.log(`[VoiceHandler] get-user-context for ${userName}`);
      this.sendToolResult(connection, toolCallId, JSON.stringify(result), false, 'get-user-context');
    } catch (err) {
      console.error(`[VoiceHandler] get-user-context error:`, err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (err as Error).message }), true, 'get-user-context');
    }
  }

  /**
   * Send a client_tool_result back to ElevenLabs. When `toolName` is provided
   * (synchronous tools), the result is also forwarded to the browser client so
   * the VoiceWindow shows what the tool returned. Async tools (send-message /
   * execute-tool) omit it: their 'processing' ack is noise, and the real result
   * reaches the client via injectAgentResult.
   */
  private sendToolResult(
    connection: VoiceConnection,
    toolCallId: string,
    result: string,
    isError: boolean,
    toolName?: string,
  ): void {
    if (connection.elevenLabsWs?.readyState === WebSocket.OPEN) {
      connection.elevenLabsWs.send(JSON.stringify({
        type: 'client_tool_result',
        tool_call_id: toolCallId,
        result,
        is_error: isError,
      }));
      console.log(`[VoiceHandler] Tool result sent for ${toolCallId}: ${result.substring(0, 100)}`);
    }
    if (toolName) {
      const preview = result.length > 800 ? `${result.substring(0, 800)}…` : result;
      this.sendToClient(connection.clientWs, {
        type: 'tool_result',
        toolName,
        text: preview,
        isError,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: list-channels
  // ---------------------------------------------------------------------------

  private async handleListChannels(
    connectionId: string,
    toolCallId: string,
    parameters: Record<string, any>,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    try {
      const { limit = 20, query, status } = parameters;

      // Build filter
      const filter: Record<string, any> = {
        userId: connection.userId,
        'metadata.transport': { $ne: 'voice' }, // exclude voice-only channels
        headless: { $ne: true },                 // exclude background worker channels
      };
      if (status) filter.status = status;

      // Fetch channels sorted by most recently updated
      const channels = await this.db
        .collection('channels')
        .find(filter)
        .sort({ updatedAt: -1 })
        .limit(Math.min(limit, 50))
        .toArray() as any[];

      // For each channel, get the last message as a preview
      const results = await Promise.all(channels.map(async (ch: any) => {
        const lastMsg = await this.db
          .collection('channel_messages')
          .findOne(
            { channelId: ch.channelId, 'content.type': 'text' },
            { sort: { timestamp: -1 } } as any,
          ) as any;

        const preview = lastMsg?.content?.text
          ? lastMsg.content.text.substring(0, 120)
          : null;

        // Apply text search filter if requested
        if (query) {
          const q = query.toLowerCase();
          const name = (ch.metadata?.name ?? '').toLowerCase();
          const previewText = (preview ?? '').toLowerCase();
          if (!name.includes(q) && !previewText.includes(q)) return null;
        }

        return {
          channel_id: ch.channelId,
          name: ch.metadata?.name ?? 'Untitled',
          status: ch.status ?? 'active',
          created_at: ch.createdAt,
          updated_at: ch.updatedAt,
          last_message_preview: preview,
          last_message_role: lastMsg?.role ?? null,
          last_message_at: lastMsg?.timestamp ?? null,
        };
      }));

      const filtered = results.filter(Boolean);

      this.sendToolResult(connection, toolCallId, JSON.stringify({
        total: filtered.length,
        channels: filtered,
      }), false, 'list-channels');

      console.log(`[VoiceHandler] list-channels: ${filtered.length} channels for user ${connection.userId}`);
    } catch (err: any) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: err.message }), true, 'list-channels');
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: list-installed-apps
  // ---------------------------------------------------------------------------

  private async handleListInstalledApps(
    connectionId: string,
    toolCallId: string,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    try {
      // Get all app access grants for this agent
      const accessDocs = await this.db.collection('agent_app_access')
        .find({ agentId: connection.agentId })
        .toArray() as any[];

      if (!accessDocs.length) {
        this.sendToolResult(connection, toolCallId, JSON.stringify({
          apps: [],
          total: 0,
        }), false, 'list-installed-apps');
        return;
      }

      // Fetch app details for each granted app
      const appIds = accessDocs.map((a: any) => a.appId);
      const apps = await this.db.collection('apps')
        .find({ appId: { $in: appIds }, status: 'active' })
        .toArray() as any[];

      // Fetch MCA manifests for descriptions and tool counts
      const results = await Promise.all(apps.map(async (app: any) => {
        const mcaId = app.mcaId;
        let description = '';
        let toolCount = 0;
        let toolExposure = 'direct';

        try {
          const manifestPath = path.join('/opt/teros/mcas', mcaId, 'manifest.json');
          const toolsPath = path.join('/opt/teros/mcas', mcaId, 'tools.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            description = manifest.description || '';
          }
          if (fs.existsSync(toolsPath)) {
            const toolsJson = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
            toolCount = (toolsJson.tools || []).filter((t: any) => !t.name.startsWith('-')).length;
          }
        } catch { /* best-effort */ }

        // Read exposure from app document if available
        if (app.toolExposure) {
          toolExposure = app.toolExposure;
        }

        return {
          name: app.name,
          appId: app.appId,
          mcaId,
          description,
          tool_count: toolCount,
          exposure: toolExposure,
          status: app.status || 'active',
        };
      }));

      console.log(`[VoiceHandler] list-installed-apps: ${results.length} apps for agent ${connection.agentId}`);
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        apps: results,
        total: results.length,
      }), false, 'list-installed-apps');
    } catch (err: any) {
      console.error('[VoiceHandler] list-installed-apps error:', err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: err.message }), true, 'list-installed-apps');
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: list-app-tools
  // ---------------------------------------------------------------------------

  private async handleListAppTools(
    connectionId: string,
    toolCallId: string,
    parameters: Record<string, any>,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const appRef = parameters.app as string;
    if (!appRef || !appRef.trim()) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        error: "'app' is required — the app name or appId from list-installed-apps.",
      }), true, 'list-app-tools');
      return;
    }

    try {
      // Resolve app by name or appId
      const app = await this.db.collection('apps').findOne({
        $or: [{ appId: appRef }, { name: appRef }],
        status: 'active',
      }) as any;

      if (!app) {
        this.sendToolResult(connection, toolCallId, JSON.stringify({
          error: `App not found: ${appRef}`,
        }), true, 'list-app-tools');
        return;
      }

      // Read tools.json from the MCA directory
      const toolsPath = path.join('/opt/teros/mcas', app.mcaId, 'tools.json');
      if (!fs.existsSync(toolsPath)) {
        this.sendToolResult(connection, toolCallId, JSON.stringify({
          error: `Tools file not found for MCA: ${app.mcaId}`,
        }), true, 'list-app-tools');
        return;
      }

      const toolsJson = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
      const allTools = (toolsJson.tools || []).filter((t: any) => !t.name.startsWith('-'));

      // Read app permissions from DB
      const appDoc = await this.db.collection('apps').findOne({ appId: app.appId }) as any;
      const permissions = appDoc?.permissions;
      const defaultPermission = permissions?.defaultPermission ?? 'ask';

      const expandTools = parameters.tools as string[] | undefined;
      const wantExpand = expandTools && Array.isArray(expandTools) && expandTools.length > 0;

      const toolResults = allTools.map((t: any) => {
        const toolName = t.name;
        const configured = permissions?.tools?.[toolName] ?? defaultPermission;
        const readOnly = t.annotations?.readOnlyHint === true;
        const alwaysAsk = t.annotations?.alwaysAsk === true;
        const effective = alwaysAsk && configured !== 'forbid' ? 'ask' : configured;

        const entry: Record<string, any> = {
          name: toolName,
          description: t.description || '',
          permission: effective,
          read_only: readOnly,
          always_ask: alwaysAsk,
        };

        // Expand full input schema if requested
        if (wantExpand && expandTools!.includes(toolName)) {
          entry.input_schema = t.inputSchema;
        }

        return entry;
      });

      console.log(`[VoiceHandler] list-app-tools: ${app.name} → ${toolResults.length} tools`);
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        app: app.name,
        mca_id: app.mcaId,
        tools: toolResults,
        total: toolResults.length,
      }), false, 'list-app-tools');
    } catch (err: any) {
      console.error('[VoiceHandler] list-app-tools error:', err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: err.message }), true, 'list-app-tools');
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: execute-tool
  // ---------------------------------------------------------------------------

  private async handleExecuteTool(
    connectionId: string,
    toolCallId: string,
    parameters: Record<string, any>,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { app: appRef, tool: toolRef, input: toolInput } = parameters;

    if (typeof appRef !== 'string' || !appRef.trim()) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        error: "'app' is required — the app name or appId from list-installed-apps.",
      }), true);
      return;
    }
    if (typeof toolRef !== 'string' || !toolRef.trim()) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        error: "'tool' is required — the tool name from list-app-tools.",
      }), true);
      return;
    }

    try {
      // AF-2: When a chatChannelId is linked, run the tool execution worker IN the
      // conversation channel so it has access to the full conversation history.
      // Falls back to creating a headless worker channel when no chatChannelId.
      let workerChannelId: string;
      if (connection.chatChannelId) {
        workerChannelId = connection.chatChannelId;
        // Point originChannelId at the voice channel for turn event routing,
        // and stamp conversationChannelId for traceability (AF-2).
        await this.linkWorkerOriginToVoice(connection, workerChannelId);
      } else {
        workerChannelId = await this.createAgentChannel(
          connection.userId,
          connection.agentId,
          connection.voiceChannelId,
          connection.workspaceId,
        );
      }

      // Route the worker's turn events to this voice channel
      await this.registerWorkerChannel(connection, workerChannelId);

      // Build a structured prompt for the worker agent
      const inputJson = toolInput && Object.keys(toolInput).length > 0
        ? JSON.stringify(toolInput)
        : '{}';
      const agentPrompt = `Execute tool "${toolRef}" from app "${appRef}" with input: ${inputJson}. `
        + `Report the result faithfully and completely, ALWAYS preserving every identifier `
        + `(message ids, event ids, item ids...) exactly as returned — follow-up calls need them. `
        + `If the call fails, report the actual error verbatim; do not speculate about apps or tools not being installed.`;

      // Notify frontend
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'execute-tool',
        parameters: { app: appRef, tool: toolRef, input: toolInput },
        channelId: workerChannelId,
      });

      // Respond immediately with channel_id (async pattern, same as send-message)
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        channel_id: workerChannelId,
        status: 'processing',
      }), false);

      // Save tool call transcript — AF-5: now also persists to chat channel via connection
      this.saveTranscript(
        connection.voiceChannelId,
        `🛠️ execute-tool → [${workerChannelId}]\napp="${appRef}" tool="${toolRef}" input=${inputJson}`,
        true,
        connection,
      ).catch((err) => {
        console.error('[VoiceHandler] Failed to save execute-tool transcript:', err);
      });

      // Launch agent — fire and forget, response arrives via setupVoiceChannelListener
      await this.runAgentAsync(connectionId, workerChannelId, agentPrompt);

      console.log(`[VoiceHandler] execute-tool → worker ${workerChannelId}: app="${appRef}" tool="${toolRef}"`);
    } catch (error) {
      console.error('[VoiceHandler] execute-tool error:', error);
      await this.saveTranscript(
        connection.voiceChannelId,
        `❌ Error en execute-tool: ${(error as Error).message}`,
        false,
        connection,
      ).catch((transcriptErr) => {
        console.error('[VoiceHandler] Failed to save execute-tool error transcript:', transcriptErr);
      });
      this.sendToClient(connection.clientWs, {
        type: 'tool_error',
        error: (error as Error).message,
      });
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        error: (error as Error).message,
      }), true);
    }
  }

  // ---------------------------------------------------------------------------
  // AGENT EXECUTION
  // ---------------------------------------------------------------------------

  /**
   * AF-2: Point a worker channel's originChannelId at the current voice channel
   * so turn events (turn_start/turn_end, permission notifications) route back to
   * the voice session. Used when the worker runs inside the conversation channel.
   *
   * On the FIRST call for a session, saves the channel's previous originChannelId
   * (if any) into connection.savedOriginChannelId so cleanup() can restore it.
   * Also stamps conversationChannelId on the channel document for traceability.
   */
  private async linkWorkerOriginToVoice(
    connection: VoiceConnection,
    workerChannelId: string,
  ): Promise<void> {
    const chatCh = await this.channelManager.getChannel(workerChannelId);
    if (!chatCh) return;

    const currentOrigin = (chatCh as any).originChannelId ?? null;

    // Save the previous originChannelId once per session so cleanup can restore it.
    // Only save on the first call — subsequent delegations in the same session
    // already have the voice channel as origin, so there's nothing new to preserve.
    if (connection.savedOriginChannelId === undefined) {
      connection.savedOriginChannelId = currentOrigin;
    }

    if (currentOrigin !== connection.voiceChannelId) {
      await this.db.collection('channels').updateOne(
        { channelId: workerChannelId },
        {
          $set: {
            originChannelId: connection.voiceChannelId,
            // Traceability: record which conversation channel the worker ran in (spec §2.3.2).
            conversationChannelId: workerChannelId,
          },
        },
      );
    }
  }

  /**
   * Create a headless worker channel that reports turn events back to the voice channel.
   * originChannelId wires it into the task_update event system automatically.
   * workspaceId must be passed explicitly because the voice agent is a superagent (workspaceId=null).
   */
  private async createAgentChannel(userId: string, agentId: string, voiceChannelId: string, workspaceId: string): Promise<string> {
    const channel = await this.channelManager.createChannel(
      userId,
      agentId,
      { transport: 'voice', name: 'Voice Task' },
      { headless: true, originChannelId: voiceChannelId, workspaceId },
    );
    return channel.channelId;
  }

  /**
   * Subscribe the voice channel to the worker's turn events (channel:turn_start /
   * channel:turn_end) via MCAEventSubscriptionService — the single delivery path
   * for turn events. mode=notify: the voice channel has no LLM agent to wake; the
   * virtual pubsub listener picks up the injected event instead.
   * Idempotent per worker: repeated calls for a tracked worker are no-ops.
   */
  private async registerWorkerChannel(connection: VoiceConnection, workerChannelId: string): Promise<void> {
    if (connection.activeWorkerChannels.has(workerChannelId)) return;

    const subs = await this.mcaEventSubscriptionService.createChannelSubscriptionsBatch([
      { topic: 'channel:turn_start', channelId: connection.voiceChannelId, rules: [{ channelId: workerChannelId }], mode: 'notify' },
      { topic: 'channel:turn_end', channelId: connection.voiceChannelId, rules: [{ channelId: workerChannelId }], mode: 'notify' },
    ]);
    connection.activeWorkerChannels.set(workerChannelId, subs.map((s) => s.id));
  }

  /**
   * Remove the worker's turn-event subscriptions and stop tracking it.
   * Untracked workers (e.g. finished after a session resume) are left to the
   * subscriptions TTL index — they no longer emit events, so they expire quietly.
   */
  private async unregisterWorkerChannel(connection: VoiceConnection, workerChannelId: string): Promise<void> {
    const subIds = connection.activeWorkerChannels.get(workerChannelId);
    if (!subIds) return;
    connection.activeWorkerChannels.delete(workerChannelId);
    await Promise.all(subIds.map((id) =>
      this.mcaEventSubscriptionService.deleteChannelSubscription(id).catch((err) => {
        console.error(`[VoiceHandler] Failed to delete subscription ${id}:`, err);
      }),
    ));
  }

  /**
   * Launch the agent on the worker channel and return immediately.
   * The response will arrive asynchronously via the voice channel listener
   * set up in setupVoiceChannelListener().
   */
  private async runAgentAsync(
    connectionId: string,
    workerChannelId: string,
    userMessage: string,
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { agentId, userId } = connection;

    // Save user message (same as handleSendMessage does).
    // Tag with source:'voice' so the unified history (spec §3.1) can distinguish
    // voice-originated delegations from regular text messages — this matters when
    // the worker runs inside the conversation channel (AF-2).
    const messageId = this.channelManager.createMessageId();
    await this.channelManager.saveMessage({
      messageId,
      channelId: workerChannelId,
      role: 'user',
      userId,
      content: { type: 'text', text: userMessage },
      source: 'voice',
      timestamp: new Date().toISOString(),
    } as any);

    // Fire and forget — the turn events will arrive via the voice channel listener
    this.messageHandler.processAgentResponse(workerChannelId, agentId, userMessage).catch((err) => {
      console.error(`[VoiceHandler] Agent error for ${workerChannelId}:`, err);
      // intentional: already inside an error handler — transcript failure must not shadow the original error
      this.saveTranscript(
        connection.voiceChannelId,
        `❌ Error en worker [${workerChannelId}]: ${err.message}`,
        false,
        connection,
      ).catch((transcriptErr) => {
        console.error('[VoiceHandler] Failed to save agent error transcript:', transcriptErr);
      });
      this.sendToClient(connection.clientWs, {
        type: 'tool_error',
        error: err.message,
        channelId: workerChannelId,
      });
      this.injectAgentResult(connectionId, workerChannelId, `Sorry, there was an error: ${err.message}`);
    });
  }

  /**
   * Persistent listener on the voice channel that receives task_update events
   * emitted by MessageHandler when worker channels start/finish a turn.
   *
   * - running: true  → passive (agent started) — log only, don't wake ElevenLabs
   * - running: false → active (agent finished) — read last message and inject into ElevenLabs
   */
  private setupVoiceChannelListener(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { voiceChannelId } = connection;

    const listener = async (raw: string) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== 'event') return;

        const eventType: string = msg.event?.eventType;
        const metadata = msg.event?.metadata ?? {};

        if (eventType === 'channel_started') {
          // Passive — observed channel started working
          const { observedChannelId, observedChannelName } = metadata;
          console.log(`[VoiceHandler] Observed channel ${observedChannelId} started`);
          const conn = this.connections.get(connectionId);
          if (conn) {
            this.sendToClient(conn.clientWs, {
              type: 'channel_event',
              eventType: 'channel_started',
              observedChannelId,
              observedChannelName,
            });
          }
          return;
        }

        if (eventType === 'channel_finished') {
          // Active — observed channel finished its turn, inject result into ElevenLabs
          const observedChannelId = metadata.observedChannelId;
          if (!observedChannelId) {
            console.warn('[VoiceHandler] channel_finished without observedChannelId, skipping');
            return;
          }
          console.log(`[VoiceHandler] Observed channel ${observedChannelId} finished — fetching response`);
          const conn = this.connections.get(connectionId);
          if (conn) {
            this.sendToClient(conn.clientWs, {
              type: 'channel_event',
              eventType: 'channel_finished',
              observedChannelId,
              observedChannelName: metadata.observedChannelName,
            });
            // Task done — drop its turn-event subscriptions and stop reporting it as active
            await this.unregisterWorkerChannel(conn, observedChannelId);
          }
          const responseText = await this.readLastAssistantMessage(observedChannelId);
          if (responseText) {
            this.injectAgentResult(connectionId, observedChannelId, responseText);
          } else {
            console.warn(`[VoiceHandler] No assistant message found in observed channel ${observedChannelId}`);
          }
          return;
        }

        if (eventType === 'channel_permission') {
          // Observed channel needs user approval — notify frontend and tell ElevenLabs verbally
          const { observedChannelId, observedChannelName, toolName } = metadata;
          console.log(`[VoiceHandler] Observed channel ${observedChannelId} needs permission for ${toolName}`);
          const conn = this.connections.get(connectionId);
          if (!conn) return;
          // Notify frontend transcript
          this.sendToClient(conn.clientWs, {
            type: 'channel_event',
            eventType: 'channel_permission',
            observedChannelId,
            observedChannelName,
            toolName,
          });
          // Tell ElevenLabs to inform the user verbally
          const shortTool = toolName ? String(toolName) : 'a tool';
          conn.elevenLabsWs?.send(JSON.stringify({
            type: 'user_message',
            text: `[event] permission_required channel_id=${observedChannelId} tool=${shortTool} channel_name=${observedChannelName || observedChannelId}`,
          }));
          return;
        }

        if (eventType === 'channel_resolved') {
          // Permission resolved — notify frontend
          const { observedChannelId, observedChannelName, toolName, resolution } = metadata;
          console.log(`[VoiceHandler] Permission ${resolution} for ${toolName} in channel ${observedChannelId}`);
          const conn = this.connections.get(connectionId);
          if (conn) {
            this.sendToClient(conn.clientWs, {
              type: 'channel_event',
              eventType: 'channel_resolved',
              observedChannelId,
              observedChannelName,
              toolName,
              resolution,
            });
          }
          return;
        }

      } catch (err) {
        console.error('[VoiceHandler] Error in voice channel listener:', err);
      }
    };

    this.pubSubService?.addListener(voiceChannelId, listener);

    // Store the listener so we can remove it on cleanup
    (connection as any)._voiceChannelListener = listener;

    console.log(`[VoiceHandler] Persistent listener registered on voice channel ${voiceChannelId}`);
  }

  /**
   * Read the most recent assistant text message from a channel directly from DB.
   */
  private async readLastAssistantMessage(channelId: string): Promise<string> {
    try {
      const msg = await this.db.collection('channel_messages').findOne(
        {
          channelId,
          role: 'assistant',
          'content.type': 'text',
        },
        { sort: { timestamp: -1 } },
      );
      return (msg as any)?.content?.text ?? '';
    } catch (err) {
      console.error(`[VoiceHandler] Error reading last message from ${channelId}:`, err);
      return '';
    }
  }

  /**
   * Inject agent result back into ElevenLabs as a user message
   * so ElevenLabs can verbalize it to the user.
   */
  private injectAgentResult(connectionId: string, channelId: string, text: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { elevenLabsWs } = connection;
    if (elevenLabsWs?.readyState !== WebSocket.OPEN) return;

    console.log(`[VoiceHandler] Injecting agent result for channel ${channelId}`);

    // Save agent response transcript — AF-5: now also persists to chat channel via connection
    this.saveTranscript(
      connection.voiceChannelId,
      `✅ Respuesta de agente [${channelId}]:\n${text}`,
      false,
      connection,
    ).catch((err) => {
      console.error('[VoiceHandler] Failed to save agent result transcript:', err);
    });

    // Notify frontend of the tool result so it shows in the VoiceWindow
    this.sendToClient(connection.clientWs, {
      type: 'tool_result',
      text,
      channelId,
    });

    // First: inject the response as context. Truncated — the voice agent only needs
    // enough to summarize verbally; full text is in the transcript and the client.
    const contextText = text.length > 1500 ? `${text.substring(0, 1500)}… [truncated]` : text;
    elevenLabsWs.send(JSON.stringify({
      type: 'contextual_update',
      text: `The Teros agent has finished processing the request for channel ${channelId}. Response: ${contextText}`,
    }));

    // AF-4: In silent mode, don't force the agent to speak. The result is
    // saved (above) and injected as context (above), but we skip the
    // user_message that would wake up the agent and produce a spoken
    // response. The user can still ask about it later via direct address.
    // Spec §4.5: "Cambio de modo mientras el worker produce: el modo afecta
    // a si se habla el resultado; el worker puede terminar y su resultado
    // se guarda igualmente en C."
    if (connection.mode === 'silent' && !connection.responsePassThrough) {
      console.log(`[VoiceHandler] Silent mode: worker result saved but not spoken for ${connectionId}`);
      return;
    }

    // Then: send a user_message to wake up the agent and force it to speak
    elevenLabsWs.send(JSON.stringify({
      type: 'user_message',
      text: `[event] agent_response_ready channel_id=${channelId}`,
    }));
  }

  // ---------------------------------------------------------------------------
  // TRANSCRIPT STORAGE
  // ---------------------------------------------------------------------------

  private async saveTranscript(channelId: string, text: string, isUser: boolean, connection?: VoiceConnection): Promise<void> {
    if (!text) return;
    try {
      // AF-5: System lines (tool calls, worker results, errors) are now persisted
      // to BOTH the voice channel AND the linked chat channel. Previously they
      // were filtered out by isSystemLine and written only to the voice channel,
      // making voice-initiated actions invisible when the user returned to text.
      //
      // Speech lines (user/assistant transcripts) continue to route to the chat
      // channel when linked, falling back to the voice channel.
      const isSystemLine = (
        text.startsWith('🛠️ send-message →') ||
        text.startsWith('🛠️ execute-tool →') ||
        text.startsWith('✅ Respuesta de agente') ||
        text.startsWith('❌ Error en')
      );

      const chatChannelId = connection?.chatChannelId;

      // Primary target: speech lines → chat channel if linked; system lines → voice channel
      const primaryTargetId = (!isSystemLine && chatChannelId)
        ? chatChannelId
        : channelId;

      // Write to primary target (broadcast only when writing to the chat channel,
      // not for voice-only internal messages)
      await this.persistTranscriptLine(
        primaryTargetId, text, isUser, primaryTargetId !== channelId,
      );

      // AF-5: For system lines with a linked chat channel, also persist a copy
      // to the chat channel so the text agent can reason about voice actions.
      // System lines are stored as assistant role since they represent agent actions.
      if (isSystemLine && chatChannelId && chatChannelId !== channelId) {
        await this.persistTranscriptLine(
          chatChannelId, text, false, true,
        );
      }
    } catch (err) {
      console.error('[VoiceHandler] Error saving transcript:', err);
    }
  }

  /**
   * Create, save, and optionally broadcast a single transcript message to a channel.
   * Used by saveTranscript to avoid duplicating message creation logic for dual-write.
   */
  private async persistTranscriptLine(
    targetChannelId: string,
    text: string,
    isUser: boolean,
    broadcast: boolean,
  ): Promise<void> {
    const messageId = this.channelManager.createMessageId();
    const timestamp = new Date().toISOString();
    const message = {
      messageId,
      channelId: targetChannelId,
      role: isUser ? 'user' : 'assistant',
      content: { type: 'text', text },
      source: 'voice',
      timestamp,
    };
    await this.channelManager.saveMessage(message as any);

    if (broadcast) {
      this.pubSubService?.broadcastToTopic(`channel:${targetChannelId}`, {
        type: 'message',
        channelId: targetChannelId,
        message,
      });

      // AF-5: Also persist to the session store (session_messages) so the text
      // agent's LLM sees voice transcripts as part of its conversation history.
      // The text agent loads context via sessionStore.getMessagesForLLM(), which
      // reads from session_messages — NOT from channel_messages. Without this
      // dual-write, voice transcripts are visible in the UI but invisible to the
      // LLM, so asking "what did I say by voice?" fails.
      await this.persistTranscriptToSessionStore(targetChannelId, text, isUser);
    }
  }

  /**
   * Write a voice transcript line to the session store (session_messages) so
   * the text agent's LLM can see it as part of the conversation history.
   * AF-5: voice → text context unification.
   */
  private async persistTranscriptToSessionStore(
    channelId: string,
    text: string,
    isUser: boolean,
  ): Promise<void> {
    if (!this.sessionStore) return;

    try {
      const now = Date.now();
      const random = Math.random().toString(36).substring(2, 9);
      const msgId = `msg_${now}_${random}`;
      const partId = `part_${now}_${random}`;

      // Build a session-store compatible message.
      // UserMessage: { id, sessionID, role: 'user', time: { created } }
      // AssistantMessage requires more fields, but the session store only
      // filters on info.role — we provide the minimal shape and cast.
      const sessionMsg = isUser
        ? {
            id: msgId,
            sessionID: channelId,
            role: 'user' as const,
            time: { created: now },
          }
        : {
            id: msgId,
            sessionID: channelId,
            role: 'assistant' as const,
            time: { created: now, completed: now },
            // Minimal assistant fields — the LLM context loader only reads
            // info.role and parts, not these metadata fields.
            system: [] as string[],
            modelID: 'voice',
            providerID: 'elevenlabs',
            mode: 'voice',
            path: { cwd: '', root: '' },
          };

      await this.sessionStore.writeMessage(sessionMsg as any);

      // Write the text as a TextPart so the LLM sees the actual content
      const textPart = {
        id: partId,
        sessionID: channelId,
        messageID: msgId,
        type: 'text' as const,
        text,
        time: { start: now, end: now },
        // Mark as synthetic so the LLM knows this is a voice transcript,
        // not a directly typed message
        synthetic: true,
        metadata: { source: 'voice' },
      };
      await this.sessionStore.writePart(textPart as any);
    } catch (err) {
      console.error('[VoiceHandler] Failed to persist transcript to session store:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // PRIOR CONTEXT LOADER
  // ---------------------------------------------------------------------------

  /**
   * Load the last N transcript messages from a voice channel to inject as
   * context into a resumed ElevenLabs session. Returns a formatted string.
   */
  private async loadPriorContext(channelId: string, limit = 20): Promise<string> {
    try {
      const messages = await this.db.collection('channel_messages')
        .find(
          { channelId, role: { $in: ['user', 'assistant'] }, 'content.type': 'text' },
          { sort: { timestamp: -1 }, limit } as any,
        )
        .toArray();

      if (!messages.length) return '';

      // Reverse to chronological order
      const lines = messages.reverse().map((m: any) => {
        const speaker = m.role === 'user' ? 'User' : 'Assistant';
        const text = (m.content?.text || '').substring(0, 300);
        return `${speaker}: ${text}`;
      });

      return lines.join('\n');
    } catch (err) {
      console.error('[VoiceHandler] Error loading prior context:', err);
      return '';
    }
  }

  /**
   * Load context from the text chat channel to inject into the voice session prompt (AF-1).
   * Returns a compact summary of recent messages + files referenced in the conversation,
   * NOT raw file contents — ElevenLabs gets the summary, the worker agent reads the originals.
   *
   * Extracts file references from tool call parts (e.g. filesystem read results) so the
   * voice agent knows which files the user has in context and can delegate reads to the worker.
   */
  private async loadChatContext(chatChannelId: string): Promise<string> {
    try {
      // Load recent messages (both text and tool-call messages) from the chat channel.
      // We query channel_messages which stores all message types including tool results.
      const messages = await this.db.collection('channel_messages')
        .find(
          { channelId: chatChannelId },
          { sort: { timestamp: -1 }, limit: 40 } as any,
        )
        .toArray();

      if (!messages.length) return '';

      // Reverse to chronological order
      const chronological = messages.reverse();

      // Extract recent conversation lines (user + assistant text)
      const conversationLines: string[] = [];
      const fileReferences: string[] = [];
      const fileRefSet = new Set<string>();

      for (const m of chronological) {
        const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : null;
        if (!role) continue;

        // Extract text content
        if (m.content?.type === 'text' && m.content?.text) {
          const text = m.content.text.substring(0, 200);
          if (text.trim()) {
            conversationLines.push(`${role}: ${text}`);
          }
        }

        // Extract file references from tool call parts.
        // Tool calls in channel_messages have parts[] with tool results that may
        // contain file paths. We scan for filesystem read patterns.
        if (m.parts && Array.isArray(m.parts)) {
          for (const part of m.parts) {
            if (part.type === 'tool' && part.state?.result) {
              const resultStr = typeof part.state.result === 'string'
                ? part.state.result
                : JSON.stringify(part.state.result);
              // Extract file paths from tool results (filesystem reads, etc.)
              const filePathMatches = resultStr.match(/(?:\/workspace\/|\/opt\/teros\/)[^\s"'<>\]]+/g);
              if (filePathMatches) {
                for (const fp of filePathMatches) {
                  if (!fileRefSet.has(fp)) {
                    fileRefSet.add(fp);
                    fileReferences.push(fp);
                  }
                }
              }
            }
            // Also check tool input for file paths (the tool call args)
            if (part.type === 'tool' && part.input) {
              const inputStr = typeof part.input === 'string'
                ? part.input
                : JSON.stringify(part.input);
              const inputFilePaths = inputStr.match(/(?:\/workspace\/|\/opt\/teros\/)[^\s"'<>\]]+/g);
              if (inputFilePaths) {
                for (const fp of inputFilePaths) {
                  if (!fileRefSet.has(fp)) {
                    fileRefSet.add(fp);
                    fileReferences.push(fp);
                  }
                }
              }
            }
          }
        }

        // Also check content.text for file paths mentioned in messages
        if (m.content?.type === 'text' && m.content?.text) {
          const textFilePaths = m.content.text.match(/(?:\/workspace\/|\/opt\/teros\/)[^\s"'<>\]]+/g);
          if (textFilePaths) {
            for (const fp of textFilePaths) {
              if (!fileRefSet.has(fp)) {
                fileRefSet.add(fp);
                fileReferences.push(fp);
              }
            }
          }
        }
      }

      // Build the compact context string
      const sections: string[] = [];

      // Recent conversation summary (last N lines)
      if (conversationLines.length > 0) {
        const recentLines = conversationLines.slice(-15);
        sections.push(`Recent conversation:\n${recentLines.join('\n')}`);
      }

      // File references — compact summary, NOT raw contents
      if (fileReferences.length > 0) {
        const fileList = fileReferences.map(f => `  - ${f}`).join('\n');
        sections.push(
          `Files the user has in context (read in the text conversation):\n${fileList}\n`
          + `The user has read these files. If they ask about file contents, delegate to the `
          + `Teros agent via send-message — the agent can read the files for details.`
        );
      }

      if (sections.length === 0) return '';

      const context = sections.join('\n\n');
      console.log(`[VoiceHandler] loadChatContext(${chatChannelId}): ${conversationLines.length} messages, ${fileReferences.length} files referenced`);
      return context;
    } catch (err) {
      console.error('[VoiceHandler] Error loading chat context:', err);
      return '';
    }
  }

  /**
   * Load historic transcripts from a voice channel to hydrate the frontend UI on reconnect.
   * Returns only user/assistant speech lines (no tool call system lines).
   * Excludes internal system lines (tool calls, tool results, etc.)
   */
  private async loadHistoricTranscripts(
    channelId: string,
    limit = 50,
  ): Promise<Array<{ id: string; text: string; isUser: boolean; timestamp: number; type?: string }>> {
    try {
      const messages = await this.db.collection('channel_messages')
        .find(
          { channelId, role: { $in: ['user', 'assistant'] }, 'content.type': 'text' },
          { sort: { timestamp: -1 }, limit } as any,
        )
        .toArray();

      if (!messages.length) return [];

      // Reverse to chronological order, filter out internal system lines
      return messages
        .reverse()
        .filter((m: any) => {
          const text: string = m.content?.text || '';
          // Skip internal tool/system lines stored by the backend
          if (text.startsWith('🛠️ send-message →')) return false;
          if (text.startsWith('🛠️ execute-tool →')) return false;
          if (text.startsWith('✅ Respuesta de agente')) return false;
          if (text.startsWith('❌ Error en')) return false;
          return true;
        })
        .map((m: any) => ({
          id: m.messageId || m._id?.toString() || `${Date.now()}_${Math.random()}`,
          text: m.content?.text || '',
          isUser: m.role === 'user',
          timestamp: new Date(m.timestamp).getTime(),
          type: 'transcript' as const,
        }));
    } catch (err) {
      console.error('[VoiceHandler] Error loading historic transcripts:', err);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // UTILS
  // ---------------------------------------------------------------------------

  private sendToClient(ws: WebSocket, payload: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private cleanup(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    console.log(`[VoiceHandler] Cleanup: ${connectionId}`);

    // Remove the persistent voice channel listener
    const listener = (connection as any)._voiceChannelListener;
    if (listener) {
      this.pubSubService?.removeListener(connection.voiceChannelId, listener);
      console.log(`[VoiceHandler] Voice channel listener removed for ${connection.voiceChannelId}`);
    }

    // Drop turn-event subscriptions of workers still in flight — the session is
    // over, so nobody is listening for their results anymore.
    for (const workerChannelId of Array.from(connection.activeWorkerChannels.keys())) {
      this.unregisterWorkerChannel(connection, workerChannelId).catch((err) => {
        console.error(`[VoiceHandler] Failed to unregister worker ${workerChannelId}:`, err);
      });
    }

    // AF-2: Restore the conversation channel's originChannelId to its pre-voice
    // value. While the voice session was active we pointed it at the voice channel
    // to route turn events; now that the session is over, leaving it pointing at
    // a dead voice channel would cause stale event routing for future text turns.
    if (connection.chatChannelId && connection.savedOriginChannelId !== undefined) {
      const restoreValue = connection.savedOriginChannelId;
      this.db.collection('channels').updateOne(
        { channelId: connection.chatChannelId },
        // If the original was null/undefined, unset it; otherwise restore it.
        restoreValue
          ? { $set: { originChannelId: restoreValue } }
          : { $unset: { originChannelId: '' } },
      ).catch((err) => {
        console.error(`[VoiceHandler] Failed to restore originChannelId on ${connection.chatChannelId}:`, err);
      });
    }

    connection.elevenLabsWs?.close();
    connection.clientWs?.close();
    this.connections.delete(connectionId);
  }

  private generateConnectionId(): string {
    return `voice_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  getActiveConnectionsCount(): number {
    return this.connections.size;
  }

  cleanupAll(): void {
    console.log('[VoiceHandler] Cleaning up all connections');
    for (const connectionId of this.connections.keys()) {
      this.cleanup(connectionId);
    }
  }
}
