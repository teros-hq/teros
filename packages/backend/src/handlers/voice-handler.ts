/**
 * Voice Handler - WebSocket Proxy for ElevenLabs Conversational AI
 *
 * Supports ElevenLabs client tool calling:
 * - Tool: send_message(message, channel_id?)
 *   - Creates or continues a conversation with the Teros agent
 *   - Returns { channel_id } immediately (async)
 *   - When agent finishes, sends tool_result back to ElevenLabs
 */

import type { Db } from 'mongodb';
import WebSocket from 'ws';
import { AuthService } from '../auth/auth-service';
import type { ChannelManager } from '../services/channel-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { SessionManager } from '../services/session-manager';
import type { MessageHandler } from './message-handler';

// =============================================================================
// TYPES
// =============================================================================

interface VoiceConnection {
  clientWs: WebSocket;
  elevenLabsWs: WebSocket | null;
  userId: string;
  voiceChannelId: string; // channel for the voice session transcripts
  agentId: string;
  conversationId?: string;
  sessionId: string;
  // Active tool calls waiting for agent response: toolCallId → resolve
  pendingToolCalls: Map<string, (response: string) => void>;
  // Active worker channels delegated via send_message: workerChannelId → toolCallId
  // Kept so we can match the task_update "finished" event back to the right ElevenLabs tool call
  activeWorkerChannels: Map<string, string>;
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

  constructor(
    private db: Db,
    private sessionManager: SessionManager,
    private channelManager: ChannelManager,
    private secretsManager: SecretsManager,
    private messageHandler: MessageHandler,
  ) {
    this.authService = new AuthService(db);
  }

  // ---------------------------------------------------------------------------
  // CONNECTION LIFECYCLE
  // ---------------------------------------------------------------------------

  async handleConnection(
    clientWs: WebSocket,
    sessionId: string,
    agentId: string,
    existingChannelId?: string,
  ): Promise<void> {
    const connectionId = this.generateConnectionId();

    try {
      // 1. Authenticate
      const userId = await this.authenticateUser(sessionId);
      if (!userId) {
        this.sendToClient(clientWs, { type: 'error', error: 'Authentication failed' });
        clientWs.close();
        return;
      }

      console.log(`[VoiceHandler] New connection: ${connectionId} user=${userId} agent=${agentId}${existingChannelId ? ` (resuming ${existingChannelId})` : ''}`);

      // 2. Create or resume voice channel (for transcript storage)
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
          );
          voiceChannelId = voiceChannel.channelId;
        }
      } else {
        const voiceChannel = await this.channelManager.createChannel(
          userId,
          agentId,
          { transport: 'voice', name: 'Voice Conversation' },
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

      // 4b. If resuming, load recent transcript for context injection
      let priorContext = '';
      if (isResuming) {
        priorContext = await this.loadPriorContext(voiceChannelId);
      }

      // 5. Init connection
      const connection: VoiceConnection = {
        clientWs,
        elevenLabsWs: null,
        userId,
        voiceChannelId,
        agentId,
        sessionId,
        pendingToolCalls: new Map(),
        activeWorkerChannels: new Map(),
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
      this.sendToClient(clientWs, { type: 'voice_channel', channelId: voiceChannelId, isResuming });

    } catch (error) {
      console.error('[VoiceHandler] Connection error:', error);
      this.sendToClient(clientWs, { type: 'error', error: `Connection failed: ${(error as Error).message}` });
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
              name: 'send_message',
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
                    description: 'Optional. The channel_id from a previous send_message call, to continue that same task.',
                  },
                },
                required: ['message'],
              },
            },
            {
              name: 'get_channel_messages',
              description: `Read the latest messages from an active task channel. Use this when the user asks "how is it going?", "any updates?", "what happened with X?" or similar progress questions about an ongoing or completed task.`,
              parameters: {
                type: 'object',
                properties: {
                  channel_id: {
                    type: 'string',
                    description: 'The channel_id returned by a previous send_message call.',
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
              name: 'get_user_context',
              description: `Get current context about the user and the active session: user name, current date and time, and the list of active task channels open in this voice session. Call this at the start of a conversation or when you need to know who you are talking to, what time it is, or which tasks are currently running.`,
              parameters: {
                type: 'object',
                properties: {},
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
You only have access to 4 tools:
1. send_message — delegate any task or question to the Teros agent, which has access to everything (code, git, emails, calendar, files, web, etc.)
2. get_channel_messages — read the current state of an ongoing task by channel_id
3. get_user_context — get live info: current time, user name, active tasks
4. list_channels — list the user's past conversations with a preview of each

That's it. You cannot directly access emails, calendars, code, files, the internet, or any other system. For virtually everything the user asks, you must delegate via send_message. The only exceptions are casual small talk and questions answerable from the 4 tools above.

HOW TO HANDLE REQUESTS:

- Casual conversation or greetings: respond directly, no tool needed.

- Anything else (code, git, emails, calendar, tasks, reminders, searches, files, data, etc.): call send_message IMMEDIATELY — do not ask for confirmation, do not explain what you are about to do. Say one short phrase while the task runs, then wait for the result. When the result arrives, summarize it conversationally.

- Progress questions ("how is it going?", "any updates?"): call get_channel_messages with the relevant channel_id.

- Questions about time, date, or active tasks: call get_user_context.

- Questions about past conversations: call list_channels, then get_channel_messages if the user wants details.

MANAGING MULTIPLE TASKS:
- Each send_message call returns a channel_id. Remember it — each one is an independent task.
- Results arrive automatically when the task finishes. No need to poll.
- If the user asks about a specific task, use get_channel_messages with that task's channel_id.

<examples>
Example 1 — Git / code:
User: "Do we have everything committed in the repository?"
You (spoken): "Give me a second."
You (tool call): send_message("Please check the current state of the git repository: show recent commits, any uncommitted changes, and the current branch.")

Example 2 — Email:
User: "Do I have any urgent emails?"
You (spoken): "Let me check."
You (tool call): send_message("Check the inbox for urgent or unread emails and give me a summary of the most important ones.")

Example 3 — Task status:
User: "How is that task going?"
You (tool call): get_channel_messages(channel_id="ch_xxx")
You (spoken): summarize what the messages say.

Example 4 — Past conversation:
User: "What did we talk about yesterday regarding the voice feature?"
You (tool call): list_channels(query="voice")
You (tool call): get_channel_messages(channel_id="ch_yyy")
You (spoken): summarize the relevant content.

Example 5 — Anything that needs data:
User: "What's on my calendar today?"
You (spoken): "One moment."
You (tool call): send_message("What events does the user have on their calendar today?")
</examples>

STYLE:
- Talk like a human, not a robot.
- Be concise. Short answers. Max 2-3 sentences unless listing items.
- Never mention internal IDs (channel IDs, message IDs, etc.) unless the user explicitly asks.
- Never end with open-ended questions like "Is there anything else?". Close naturally.
- Never explain that you are delegating or mention tool names to the user.

TOOL DISCIPLINE:
- Once you call send_message, do NOT call it again for the same request. The result will arrive on its own.
- While waiting, say ONE brief phrase — then stop talking. Do not keep chatting while the task runs.
- Only call send_message again if the user explicitly changes or corrects the request.`;
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
      } catch {
        // non-JSON (shouldn't happen)
      }
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

        // Save transcripts
        if (message.type === 'user_transcript') {
          this.saveTranscript(connection.voiceChannelId, message.user_transcription_event?.user_transcript, true).catch(() => {});
        }
        if (message.type === 'agent_response') {
          this.saveTranscript(connection.voiceChannelId, message.agent_response_event?.agent_response, false).catch(() => {});
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

    elevenLabsWs.on('close', () => {
      console.log(`[VoiceHandler] ElevenLabs disconnected: ${connectionId}`);
      this.cleanup(connectionId);
    });

    elevenLabsWs.on('error', (err) => {
      console.error(`[VoiceHandler] ElevenLabs error: ${connectionId}`, err);
      this.cleanup(connectionId);
    });
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: send_message
  // ---------------------------------------------------------------------------

  private async handleToolCall(connectionId: string, message: ElevenLabsMessage): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const toolCallId: string = message.tool_call_id || message.client_tool_call?.tool_call_id;
    const toolName: string = message.tool_name || message.client_tool_call?.tool_name;
    const parameters = message.parameters || message.client_tool_call?.parameters || {};

    console.log(`[VoiceHandler] Tool call: ${toolName} (${toolCallId})`);

    if (toolName === 'get_channel_messages') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'get_channel_messages',
        parameters: { channel_id: parameters.channel_id, limit: parameters.limit },
      });
      await this.handleGetChannelMessages(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName === 'get_user_context') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'get_user_context',
        parameters: {},
      });
      await this.handleGetUserContext(connectionId, toolCallId);
      return;
    }

    if (toolName === 'list_channels') {
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'list_channels',
        parameters: { query: parameters.query, limit: parameters.limit },
      });
      await this.handleListChannels(connectionId, toolCallId, parameters);
      return;
    }

    if (toolName !== 'send_message') {
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: `Unknown tool: ${toolName}` }), true);
      return;
    }

    const { message: userMessage, channel_id: existingChannelId } = parameters;

    try {
      // Get or create worker channel — always with originChannelId pointing to the voice channel
      let workerChannelId: string;
      if (existingChannelId) {
        const existing = await this.channelManager.getChannel(existingChannelId);
        workerChannelId = existing ? existingChannelId : await this.createAgentChannel(connection.userId, connection.agentId, connection.voiceChannelId);
      } else {
        workerChannelId = await this.createAgentChannel(connection.userId, connection.agentId, connection.voiceChannelId);
      }

      console.log(`[VoiceHandler] send_message → worker ${workerChannelId}: "${userMessage.substring(0, 80)}..."`);

      // Track this worker channel so we can correlate events back to the tool call
      connection.activeWorkerChannels.set(workerChannelId, toolCallId);

      // Save tool call to voice channel transcript
      await this.saveTranscript(
        connection.voiceChannelId,
        `🛠️ send_message → [${workerChannelId}]\n"${userMessage}"`,
        true,
      ).catch(() => {});

      // Notify frontend of the tool call so it shows in the VoiceWindow
      this.sendToClient(connection.clientWs, {
        type: 'tool_call',
        toolName: 'send_message',
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

      // Launch agent — fire and forget, response arrives via setupVoiceChannelListener
      await this.runAgentAsync(connectionId, workerChannelId, userMessage);

    } catch (error) {
      console.error(`[VoiceHandler] Tool call error:`, error);
      await this.saveTranscript(
        connection.voiceChannelId,
        `❌ Error en tool call: ${(error as Error).message}`,
        false,
      ).catch(() => {});
      this.sendToClient(connection.clientWs, {
        type: 'tool_error',
        error: (error as Error).message,
      });
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (error as Error).message }), true);
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: get_channel_messages
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
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: 'channel_id is required' }), true);
      return;
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

      const isActive = connection.activeWorkerChannels.has(channelId);

      console.log(`[VoiceHandler] get_channel_messages: ${channelId} → ${result.length} messages`);
      this.sendToolResult(connection, toolCallId, JSON.stringify({
        channel_id: channelId,
        status: isActive ? 'processing' : 'completed',
        message_count: result.length,
        messages: result,
      }), false);
    } catch (err) {
      console.error(`[VoiceHandler] get_channel_messages error:`, err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (err as Error).message }), true);
    }
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: get_user_context
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

      const result = {
        user: {
          name: userName,
          email: userEmail,
        },
        current_time: new Date().toISOString(),
        voice_channel_id: connection.voiceChannelId,
        active_tasks: activeTasks,
        active_task_count: activeTasks.length,
      };

      console.log(`[VoiceHandler] get_user_context for ${userName}`);
      this.sendToolResult(connection, toolCallId, JSON.stringify(result), false);
    } catch (err) {
      console.error(`[VoiceHandler] get_user_context error:`, err);
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: (err as Error).message }), true);
    }
  }

  private sendToolResult(
    connection: VoiceConnection,
    toolCallId: string,
    result: string,
    isError: boolean,
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
  }

  // ---------------------------------------------------------------------------
  // TOOL CALL: list_channels
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
      }), false);

      console.log(`[VoiceHandler] list_channels: ${filtered.length} channels for user ${connection.userId}`);
    } catch (err: any) {
      this.sendToolResult(connection, toolCallId, JSON.stringify({ error: err.message }), true);
    }
  }

  // ---------------------------------------------------------------------------
  // AGENT EXECUTION
  // ---------------------------------------------------------------------------

  /**
   * Create a headless worker channel that reports turn events back to the voice channel.
   * originChannelId wires it into the task_update event system automatically.
   */
  private async createAgentChannel(userId: string, agentId: string, voiceChannelId: string): Promise<string> {
    const channel = await this.channelManager.createChannel(
      userId,
      agentId,
      { transport: 'voice', name: 'Voice Task' },
      { headless: true, originChannelId: voiceChannelId },
    );
    return channel.channelId;
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

    // Save user message (same as handleSendMessage does)
    const messageId = this.channelManager.createMessageId();
    await this.channelManager.saveMessage({
      messageId,
      channelId: workerChannelId,
      role: 'user',
      userId,
      content: { type: 'text', text: userMessage },
      timestamp: new Date().toISOString(),
    } as any);

    // Fire and forget — the turn events will arrive via the voice channel listener
    this.messageHandler.processAgentResponse(workerChannelId, agentId, userMessage).catch((err) => {
      console.error(`[VoiceHandler] Agent error for ${workerChannelId}:`, err);
      this.saveTranscript(
        connection.voiceChannelId,
        `❌ Error en worker [${workerChannelId}]: ${err.message}`,
        false,
      ).catch(() => {});
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

        if (msg.type !== 'event' || msg.event?.eventType !== 'task_update') return;

        const { running, workerChannelId, agentName } = msg.event.metadata ?? {};

        if (running) {
          // Passive — agent started working, just log
          console.log(`[VoiceHandler] Worker ${workerChannelId} started (passive event)`);
          return;
        }

        // Active — agent finished its turn
        console.log(`[VoiceHandler] Worker ${workerChannelId} finished turn — fetching response`);

        if (!workerChannelId) {
          console.warn('[VoiceHandler] task_update without workerChannelId, skipping');
          return;
        }

        // Read the last assistant text message from the worker channel
        const responseText = await this.readLastAssistantMessage(workerChannelId);

        if (responseText) {
          this.injectAgentResult(connectionId, workerChannelId, responseText);
        } else {
          console.warn(`[VoiceHandler] No assistant message found in worker ${workerChannelId}`);
        }
      } catch (err) {
        console.error('[VoiceHandler] Error in voice channel listener:', err);
      }
    };

    this.sessionManager.addChannelListener(voiceChannelId, listener);

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

    // Save agent response to voice channel
    this.saveTranscript(
      connection.voiceChannelId,
      `✅ Respuesta de agente [${channelId}]:\n${text}`,
      false,
    ).catch(() => {});

    // Notify frontend of the tool result so it shows in the VoiceWindow
    this.sendToClient(connection.clientWs, {
      type: 'tool_result',
      text,
      channelId,
    });

    // First: inject the full response as context
    elevenLabsWs.send(JSON.stringify({
      type: 'contextual_update',
      text: `The Teros agent has finished processing the request for channel ${channelId}. Response: ${text}`,
    }));

    // Then: send a user_message to wake up the agent and force it to speak
    elevenLabsWs.send(JSON.stringify({
      type: 'user_message',
      text: `[event] agent_response_ready channel_id=${channelId}`,
    }));
  }

  // ---------------------------------------------------------------------------
  // TRANSCRIPT STORAGE
  // ---------------------------------------------------------------------------

  private async saveTranscript(channelId: string, text: string, isUser: boolean): Promise<void> {
    if (!text) return;
    try {
      const messageId = this.channelManager.createMessageId();
      await this.channelManager.saveMessage({
        messageId,
        channelId,
        role: isUser ? 'user' : 'assistant',
        content: { type: 'text', text },
        timestamp: new Date().toISOString(),
      } as any);
    } catch (err) {
      console.error('[VoiceHandler] Error saving transcript:', err);
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
      this.sessionManager.removeChannelListener(connection.voiceChannelId, listener);
      console.log(`[VoiceHandler] Voice channel listener removed for ${connection.voiceChannelId}`);
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
