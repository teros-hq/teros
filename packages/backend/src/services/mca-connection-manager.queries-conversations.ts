/**
 * MCA Connection Manager — Conversation Queries
 *
 * Handles channel/message actions from query_conversations:
 * search_messages, list_channels, get_channel_messages, get_channel_summary,
 * create_channel, send_message, rename_channel.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { uploadDir } from '../lib/static-paths';
import type { ActiveConnection, QueryHandlerContext } from './mca-connection-manager.types';
import { assertSafePath } from './volume-service';

/**
 * Resolve the scope of the conversation an MCA is running in (the "caller").
 *
 * `scope` is a VISIBILITY flag, not a privacy flag:
 *   - 'personal' — only the creator sees the conversation (the default for every
 *     channel created since MUW; see ChannelManager.createChannel)
 *   - 'shared'   — visible to all workspace members
 *
 * A missing scope is treated as 'personal' (defense in depth, NFR-3).
 * The caller channel id comes from the MCA tool params (`callerChannelId`, the
 * race-free path also used by board-manager/delegate-task) with the connection
 * context as a fallback for stdio MCAs.
 */
async function resolveCallerScope(
  ctx: QueryHandlerContext,
  params: Record<string, unknown>,
  connection?: ActiveConnection,
): Promise<'personal' | 'shared'> {
  const callerChannelId =
    (params.callerChannelId as string | undefined) ?? connection?.currentChannelId;
  if (!callerChannelId) return 'personal';
  const caller = await ctx.channelManager!.getChannel(callerChannelId);
  return (caller?.scope as 'personal' | 'shared' | undefined) ?? 'personal';
}

// @todo alice - 2026.09.24 : extend caller-scope gate tests beyond import_channel_attachment —
// search_messages / list_channels / get_channel_messages / get_channel_summary paths have no dedicated coverage yet
// (shared caller blocked from personal targets, personal caller allowed, missing scope treated as personal)

/**
 * Enforce the caller-scope gate for reading a specific conversation.
 *
 * A 'shared' caller runs in a conversation every workspace member can see, so
 * letting it pull the owner's 'personal' history would leak it to the whole
 * workspace. A 'personal' caller is the owner's own context and may read any of
 * their conversations. Shared targets are readable by anyone with channel access.
 */
async function assertCallerCanReadChannel(
  ctx: QueryHandlerContext,
  params: Record<string, unknown>,
  connection: ActiveConnection | undefined,
  targetScope: string | undefined,
): Promise<void> {
  if ((targetScope ?? 'personal') !== 'personal') return;
  const callerScope = await resolveCallerScope(ctx, params, connection);
  if (callerScope === 'shared') {
    throw new Error('Cannot access a personal conversation from a shared conversation');
  }
}

/**
 * Handle conversation/channel query actions.
 * @returns result data to send back to the MCA
 */
export async function handleConversationAction(
  ctx: QueryHandlerContext,
  action: string,
  params: Record<string, unknown>,
  userId: string,
  effectiveAgentId: string | undefined,
  connection?: import('./mca-connection-manager.types').ActiveConnection, // always provided by dispatcher
): Promise<unknown> {
  let data: unknown;

  switch (action) {
case 'search_messages': {
  const query = params.query as string;
  const limit = (params.limit as number) || 50;
  const excludeChannelId = params.excludeChannelId as string | undefined;

  if (!query || query.length < 2) {
    throw new Error('Query must be at least 2 characters');
  }

  // Caller-scope gate: a 'shared' caller must not search the owner's personal
  // conversations — they would leak into a workspace-visible context.
  const callerScope = await resolveCallerScope(ctx, params, connection);
  const results = await ctx.channelManager!.searchMessages(userId, query, limit, {
    includePersonal: callerScope !== 'shared',
  });

  // Filter out the current channel if specified
  if (excludeChannelId) {
    results.results = results.results.filter((r) => r.channelId !== excludeChannelId);
  }

  data = results;
  break;
}

case 'list_channels': {
  const status = params.status as 'active' | 'closed' | undefined;
  const limit = (params.limit as number) || 20;
  const excludeChannelId = params.excludeChannelId as string | undefined;

  const listResult = await ctx.channelManager!.listUserChannels(userId, status, {
    limit,
    workspaceId: connection!.currentWorkspaceId,
  });

  let channels = listResult.channels;

  // Caller-scope gate: a 'shared' caller must not see the owner's personal
  // conversations. A 'personal' caller sees everything it owns.
  const callerScope = await resolveCallerScope(ctx, params, connection);
  if (callerScope === 'shared') {
    channels = channels.filter((c) => (c.scope ?? 'personal') !== 'personal');
  }

  // Filter out the current channel if specified
  if (excludeChannelId) {
    channels = channels.filter((c) => c.channelId !== excludeChannelId);
  }

  data = {
    channels: channels.map((c) => ({
      channelId: c.channelId,
      name: c.metadata?.name || 'Chat',
      agentId: c.agentId,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastMessage: c.lastMessage,
    })),
    total: channels.length,
  };
  break;
}

case 'get_channel_messages': {
  const channelId = params.channelId as string;
  const limit = (params.limit as number) || 50;
  const before = params.before as string | undefined;
  const textOnly = params.textOnly !== false; // Default true

  if (!channelId) {
    throw new Error('channelId is required');
  }

  // Verify access (owner or workspace member)
  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveAgentId);
  if (!canAccess) {
    throw new Error('Access denied');
  }

  // Caller-scope gate: a 'shared' caller must not read the owner's personal history.
  await assertCallerCanReadChannel(ctx, params, connection, channel.scope);

  const result = await ctx.channelManager!.getMessages(channelId, limit, before);

  // Filter to text-only if requested
  let messages = result.messages;
  if (textOnly) {
    messages = messages.filter((m) => m.content.type === 'text');
  }

  data = {
    channel: {
      channelId: channel.channelId,
      name: channel.metadata?.name || 'Chat',
      agentId: channel.agentId,
      status: channel.status,
      createdAt: channel.createdAt,
    },
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    hasMore: result.hasMore,
  };
  break;
}

case 'get_channel_summary': {
  const channelId = params.channelId as string;

  if (!channelId) {
    throw new Error('channelId is required');
  }

  // Verify access (owner or workspace member)
  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveAgentId);
  if (!canAccess) {
    throw new Error('Access denied');
  }

  // Caller-scope gate: a 'shared' caller must not read the owner's personal history.
  await assertCallerCanReadChannel(ctx, params, connection, channel.scope);

  // Get first and last messages
  const { messages: recentMessages } = await ctx.channelManager!.getMessages(channelId, 1);
  const lastMessage = recentMessages[0];

  // Get message count (approximate by getting all and counting)
  // TODO: Add a count method to ChannelManager for efficiency
  const { messages: allMessages } = await ctx.channelManager!.getMessages(channelId, 1000);
  const messageCount = allMessages.length;

  // Find first message (oldest)
  const firstMessage = allMessages[allMessages.length - 1];

  data = {
    channelId: channel.channelId,
    name: channel.metadata?.name || 'Chat',
    agentId: channel.agentId,
    status: channel.status,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    messageCount,
    firstMessage: firstMessage
      ? {
          content:
            firstMessage.content.type === 'text'
              ? (firstMessage.content as any).text?.substring(0, 200)
              : `[${firstMessage.content.type}]`,
          timestamp: firstMessage.timestamp,
          role: firstMessage.role,
        }
      : null,
    lastMessage: lastMessage
      ? {
          content:
            lastMessage.content.type === 'text'
              ? (lastMessage.content as any).text?.substring(0, 200)
              : `[${lastMessage.content.type}]`,
          timestamp: lastMessage.timestamp,
          role: lastMessage.role,
        }
      : null,
  };
  break;
}

case 'create_channel': {
  const agentId = params.agentId as string;
  const name = params.name as string | undefined;
  const parentChannelId = params.parentChannelId as string | undefined;

  console.log(`[McaConnectionManager] create_channel: parentChannelId=${parentChannelId}, name=${name}, agentId=${agentId}`);

  if (!agentId) {
    throw new Error('[McaConnectionManager.create_channel] agentId is required');
  }

  if (!parentChannelId) {
    throw new Error(
      `[McaConnectionManager.create_channel] parentChannelId is required. ` +
      `Sub-channels must always specify their parent channel to inherit workspaceId.`
    );
  }

  // Workspace is sovereign — resolve workspaceId from the parent channel (ENGINEERING-PRINCIPLES.md)
  // We always read from the parent channel directly rather than relying on connection!.currentWorkspaceId,
  // which is not set for HTTP-based MCAs (context is per-call, not per-connection).
  const parentChannel = await ctx.channelManager!.getChannel(parentChannelId);
  if (!parentChannel) {
    throw new Error(
      `[McaConnectionManager.create_channel] parentChannelId "${parentChannelId}" not found. Cannot inherit workspaceId.`
    );
  }
  if (!parentChannel.workspaceId) {
    throw new Error(
      `[McaConnectionManager.create_channel] parentChannel "${parentChannelId}" has no workspaceId. Cannot inherit workspaceId.`
    );
  }

  const newChannel = await ctx.channelManager!.createChannel(
    userId,
    agentId,
    name ? { name } : undefined,
    {
      workspaceId: parentChannel.workspaceId,
      originChannelId: parentChannelId,
    },
  );

  // When delegate-task creates a sub-channel, atomically register 2 subscriptions
  // in subscriptions_channel so the parent channel receives channel events:
  //   1. channel:*            → notify  (any event from the sub-channel)
  //   2. channel:turn_end     → wake    (sub-agent finished, parent must react)
  // Permission notification to the parent now uses the dual-broadcast WS path in
  // permission-manager.ts:broadcastToChannelAndObservers (TER-338). The old
  // 'channel:permission_request' wake rule has been removed — nobody dispatched
  // that topic in the codebase (verified with grep), so the subscription was
  // dead weight.
  if (parentChannelId && ctx.mcaEventSubscriptionService) {
    await ctx.mcaEventSubscriptionService.createChannelSubscriptionsBatch([
      {
        topic: 'channel:*',
        channelId: parentChannelId,
        rules: [{ channelId: newChannel.channelId }],
        mode: 'notify',
      },
      {
        topic: 'channel:turn_end',
        channelId: parentChannelId,
        rules: [{ channelId: newChannel.channelId }],
        mode: 'wake',
      },
    ]);
  }

  data = {
    channelId: newChannel.channelId,
    agentId: newChannel.agentId,
    name: newChannel.metadata?.name || 'New conversation',
    status: newChannel.status,
    createdAt: newChannel.createdAt,
    updatedAt: newChannel.updatedAt,
  };
  break;
}

case 'send_message': {
  const channelId = params.channelId as string;
  const message = params.message as string;

  // Sender identity — explicit senderType + senderId is the preferred path.
  // Backwards compat: senderAgentId (legacy) is mapped to senderType='agent'.
  // If neither is provided, fall back to the connection's userId (user-sent).
  const senderType = params.senderType as 'agent' | 'user' | undefined;
  const senderId = params.senderId as string | undefined;
  const legacySenderAgentId = params.senderAgentId as string | undefined;

  // Resolve effective sender: explicit > legacy > connection fallback
  const effectiveSenderType: 'agent' | 'user' =
    senderType ?? (legacySenderAgentId ? 'agent' : 'user');
  const effectiveSenderId: string | undefined =
    senderId ?? legacySenderAgentId ?? connection!.currentAgentId;

  if (!channelId) {
    throw new Error('channelId is required');
  }
  if (!message || message.trim().length === 0) {
    throw new Error('message is required and cannot be empty');
  }

  // Verify channel exists and user has access
  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveSenderId);
  if (!canAccess) {
    throw new Error('Access denied');
  }

  // Create and save the message
  const messageId = ctx.channelManager!.createMessageId();
  const timestamp = new Date().toISOString();

  // Build sender from explicit identity — no silent fallback to user.
  // If senderType is 'agent' but the agent doesn't resolve, that's an error
  // we want to see, not something to silently mask as a user message.
  let sender: { type: 'user' | 'agent'; id: string; name: string; avatarUrl?: string } | undefined;
  if (effectiveSenderType === 'agent' && effectiveSenderId) {
    sender = (await ctx.channelManager!.getAgentSender(effectiveSenderId)) || undefined;
    if (!sender) {
      console.warn(
        `[McaConnectionManager] send_message: agent sender not found for id=${effectiveSenderId}, ` +
        `falling back to user ${userId}. This may indicate a stale agent reference.`,
      );
      sender = (await ctx.channelManager!.getUserSender(userId)) || undefined;
    }
  } else {
    // senderType === 'user' — use the authenticated user
    sender = (await ctx.channelManager!.getUserSender(userId)) || undefined;
  }

  const userMessage = {
    messageId,
    channelId,
    role: 'user' as const,
    userId,
    sender,
    content: { type: 'text' as const, text: message },
    timestamp,
  };

  await ctx.channelManager!.saveMessage(userMessage);

  // Broadcast the user message to all channel subscribers so frontends
  // with that channel open render it in real-time (mirrors handleSendMessage
  // in message-handler.ts). Without this, the message is saved and the agent
  // processes it, but the frontend never receives the WebSocket push.
  ctx.pubSubService?.broadcastToTopic(`channel:${channelId}`, {
    type: 'message',
    channelId,
    message: userMessage,
  });

  // Emit event so MessageHandler can process the agent response
  // This is done via the 'mca:send_message' event
  ctx.emit('mca:send_message', {
    channelId,
    agentId: channel.agentId,
    message: message,
  });

  data = {
    success: true,
    messageId,
    channelId,
    timestamp,
  };
  break;
}

case 'rename_channel': {
  const channelId = params.channelId as string;
  const name = params.name as string;

  if (!channelId) {
    throw new Error('channelId is required');
  }
  if (!name || name.trim().length === 0) {
    throw new Error('name is required and cannot be empty');
  }

  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }

  // Verify access
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveAgentId);
  if (!canAccess) {
    throw new Error('Access denied');
  }

  await ctx.channelManager!.renameChannel(channelId, name.trim());

  data = {
    success: true,
    channelId,
    name: name.trim(),
  };
  break;
}

case 'import_channel_attachment': {
  if (!ctx.volumeService || !ctx.workspaceService) {
    throw new Error('[import_channel_attachment] volumeService/workspaceService unavailable');
  }

  const channelId = (params.channelId as string) || connection?.currentChannelId;
  const filename = params.filename as string;
  const messageId = params.messageId as string | undefined;
  const destPath = params.destPath as string | undefined;
  const overwrite = params.overwrite === true;

  if (!channelId) {
    throw new Error('channelId is required (no current channel in context)');
  }
  if (!filename || filename.trim().length === 0) {
    throw new Error('filename is required');
  }

  // Access control — owner or workspace member; MCAs cannot touch private channels.
  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveAgentId);
  if (!canAccess) {
    throw new Error('Access denied');
  }
  // Caller-scope gate: a 'shared' caller must not import from the owner's personal history.
  await assertCallerCanReadChannel(ctx, params, connection, channel.scope);

  // Workspace is sovereign — the destination volume derives ONLY from the channel's
  // workspace, never from an agent-supplied param (ENGINEERING-PRINCIPLES.md §6).
  if (!channel.workspaceId) {
    throw new Error('Channel has no workspace; cannot resolve destination volume');
  }
  const workspace = await ctx.workspaceService.getWorkspace(channel.workspaceId);
  if (!workspace?.volumeId) {
    throw new Error('Workspace has no volume');
  }
  const volume = await ctx.volumeService.getVolume(workspace.volumeId);
  if (!volume?.hostPath) {
    throw new Error('Volume host path unavailable');
  }

  // Locate the attachment among the channel's recent messages. The agent-supplied
  // `filename` is used ONLY to match — the source path is derived from the URL
  // persisted server-side, never from agent input (no traversal/exfiltration).
  // Normalize: strip markdown chars, NFC-normalize Unicode (BD may store NFD
  // combining diacriticals while agents send NFC precomposed), and lowercase
  // for case-insensitive comparison.
  const normalize = (s: string) =>
    s.replace(/[[\]()]/g, '_').trim().normalize('NFC').toLowerCase();
  const target = normalize(filename);
  const { messages } = await ctx.channelManager!.getMessages(channelId, 200);
  const matches = messages.filter((m) => {
    const c = m.content as { type?: string; url?: string; filename?: string };
    return (
      c?.type === 'file' &&
      typeof c.url === 'string' &&
      typeof c.filename === 'string' &&
      normalize(c.filename) === target &&
      (messageId ? m.messageId === messageId : true)
    );
  });
  if (matches.length === 0) {
    // Diagnostic: log what we searched and what we found, to identify the root cause.
    const fileMessages = messages.filter((m) => {
      const c = m.content as { type?: string };
      return c?.type === 'file';
    });
    const allTypes = messages.map((m) => {
      const c = m.content as { type?: string };
      return c?.type || typeof m.content;
    });
    console.warn(
      `[import_channel_attachment] NO MATCH. channel=${channelId} target="${target}" ` +
      `totalMsgs=${messages.length} fileMsgs=${fileMessages.length} ` +
      `fileFilenames=${JSON.stringify(fileMessages.map((m) => (m.content as { filename?: string }).filename))} ` +
      `allTypes=${JSON.stringify(allTypes)}`,
    );
    throw new Error(`No attachment named "${filename}" found in this conversation`);
  }
  if (matches.length > 1 && !messageId) {
    throw new Error(`Multiple attachments named "${filename}" found; pass messageId to disambiguate`);
  }
  const match = matches[0].content as {
    type: 'file';
    url: string;
    filename: string;
    mimeType?: string;
    size?: number;
  };

  // Source: basename of the stored URL (already sanitized at upload time to
  // [a-zA-Z0-9_-] + uuid + ext, so it cannot contain traversal sequences).
  let sourceBase: string;
  try {
    sourceBase = basename(new URL(match.url).pathname);
  } catch {
    sourceBase = basename(match.url);
  }
  if (!sourceBase || sourceBase === '.' || sourceBase === '..') {
    throw new Error('Attachment has an invalid stored URL');
  }
  const sourcePath = join(uploadDir, sourceBase);
  assertSafePath(uploadDir, sourcePath); // defense in depth
  if (!existsSync(sourcePath)) {
    throw new Error('Attachment file is no longer available on the server');
  }

  // Destination: jailed to the workspace volume root. `destPath` is agent input → hard-validate.
  const destRel = destPath && destPath.trim().length > 0 ? destPath : basename(match.filename);
  const destAbs = resolve(volume.hostPath, destRel);
  assertSafePath(volume.hostPath, destAbs); // blocks ../ traversal

  // Symlink defense: the parent dir must stay inside the volume after following
  // symlinks, and we never overwrite through a symlinked leaf. Canonicalize BOTH
  // sides so a symlinked volume root (e.g. macOS /var → /private/var) is not a
  // false positive while real escapes outside the volume are still rejected.
  const destDir = dirname(destAbs);
  await mkdir(destDir, { recursive: true });
  assertSafePath(realpathSync(volume.hostPath), realpathSync(destDir));
  if (existsSync(destAbs)) {
    if (!overwrite) {
      throw new Error(
        `Destination "${relative(volume.hostPath, destAbs)}" already exists (set overwrite to replace)`,
      );
    }
    if (lstatSync(destAbs).isSymbolicLink()) {
      throw new Error('Refusing to overwrite a symlink destination');
    }
  }

  await copyFile(sourcePath, destAbs);

  console.log(
    `[import_channel_attachment] user=${userId} channel=${channelId} workspace=${channel.workspaceId} file="${match.filename}" -> ${relative(volume.hostPath, destAbs)}`,
  );

  data = {
    success: true,
    filename: match.filename,
    workspacePath: relative(volume.hostPath, destAbs),
    size: match.size ?? null,
    mime: match.mimeType ?? null,
  };
  break;
}

case 'redact_by_value': {
  // Agent secret tools (docs/specs/20261031_agent-secret-tools.md, design A).
  // Value-based redaction sweep over the calling channel. Permission is asked
  // at the TOOL layer (alwaysAsk annotation on the conversations MCA tool) —
  // by the time this runs the user has confirmed. Authorization here is the
  // narrow exception to owner-only canRedact: the acting agent may redact
  // ONLY messages matching the given value, in the calling channel.
  const channelId = (params.channelId as string) || connection?.currentChannelId;
  const value = params.value as string;
  const windowNum = params.window as number | undefined;
  const alsoRedact = params.alsoRedact as string[] | undefined;

  if (!channelId) {
    throw new Error('channelId is required (no current channel in context)');
  }
  if (!value || typeof value !== 'string') {
    throw new Error('value is required');
  }

  // Access control: the acting agent must be able to access the channel it
  // is sweeping (same gate as get_channel_messages — owner or member).
  const channel = await ctx.channelManager!.getChannel(channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const canAccess = await ctx.channelManager!.canAccessChannel(channelId, userId, effectiveAgentId);
  if (!canAccess) {
    throw new Error('Access denied');
  }

  const { sweepRedactByValue } = await import('./redaction-sweep');
  const result = await sweepRedactByValue(ctx.db, ctx.channelManager!, channelId, value, {
    ...(windowNum ? { window: windowNum } : {}),
    ...(alsoRedact ? { alsoRedact } : {}),
    redactedBy: effectiveAgentId ?? userId,
  });

  // Broadcast per-message redaction events so subscribed UIs update live —
  // same shape as channel.toggle_redaction, NO content (ids + state only).
  if (ctx.pubSubService) {
    for (const messageId of result.messageIds) {
      ctx.pubSubService.broadcastToTopic(`channel:${channelId}`, {
        type: 'message_redacted',
        channelId,
        messageId,
        redacted: true,
        redactedBy: effectiveAgentId ?? userId,
        redactedAt: new Date().toISOString(),
      });
    }
  }

  // Coverage report for the agent — ids only, never the value (AC 3/6).
  data = {
    success: true,
    channelId,
    redactedCount: result.redactedCount,
    messageIds: result.messageIds,
    sessionDocsFlagged: result.sessionDocsFlagged,
    surfaces: result.surfaces,
    alsoRedacted: result.alsoRedacted,
    note:
      'Every message containing the value has been redacted (including this tool call itself). ' +
      'The owner can un-redact any of them. Reference the secret only by its mask from now on.',
  };
  break;
}

// ==================================================================
  }

  return data;
}
