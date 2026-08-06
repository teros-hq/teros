import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import { type CreateChannelResult, type SendMessageResult, getWsClient, isWsConnected } from '../lib';

export const delegateTask: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delegate a task to a new sub-conversation with an agent (defaults to yourself). Creates the conversation, sends the task prompt, and returns immediately. The sub-agent works independently and each of its responses is automatically forwarded back to this conversation.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Full task description and instructions to send to the sub-agent',
      },
      agentId: {
        type: 'string',
        description: 'Agent ID to delegate to. Defaults to the current agent (self-delegation).',
      },
      taskName: {
        type: 'string',
        description: 'Optional name for the delegated task conversation',
      },
    },
    required: ['prompt'],
  },
  handler: async (args, context: ToolContext) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const prompt = args?.prompt as string;
    const taskName = args?.taskName as string | undefined;

    if (!prompt || prompt.trim().length === 0) {
      throw new Error('prompt is required and cannot be empty');
    }

    // Per-call context (correct for per-app HTTP containers)
    const callerChannelId = context.execution.channelId;
    const callerAgentId = context.execution.agentId;

    console.error(`[delegate-task] callerChannelId=${callerChannelId}, taskName=${taskName}`);

    // Resolve target agent — default to self
    let agentId = args?.agentId as string | undefined;
    if (!agentId) {
      if (!callerAgentId) {
        throw new Error('agentId is required when not running in an agent context');
      }
      agentId = callerAgentId;
    }

    // Step 1: Create a new conversation for the task, linked to the parent channel via parentChannelId.
    // The backend resolves workspaceId from the parent channel and sets originChannelId automatically.
    // The backend will automatically forward each of the sub-agent's turns back to the parent.
    if (!callerChannelId) {
      throw new Error('[delegate-task] callerChannelId is required to inherit workspaceId from parent channel')
    }

    const channel = await wsClient.queryConversations<CreateChannelResult>('create_channel', {
      agentId,
      name: taskName || `Task: ${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`,
      parentChannelId: callerChannelId,
    });

    console.error(`[delegate-task] created channel=${channel.channelId} for callerChannelId=${callerChannelId}, taskName=${taskName}`);

    // Step 2: Build the prompt — let the sub-agent know it's in a delegated context
    const delegationContext = callerChannelId
      ? `\n\n---\n_This is a delegated task. Your responses will be automatically forwarded to the parent conversation as you complete each turn._`
      : '';

    const fullPrompt = `${prompt}${delegationContext}`;

    // Step 3: Send the task prompt — triggers async processing, returns immediately
    // Use explicit senderType + senderId so the backend doesn't need to guess.
    const sent = await wsClient.queryConversations<SendMessageResult>('send_message', {
      channelId: channel.channelId,
      message: fullPrompt,
      ...(callerAgentId
        ? { senderType: 'agent' as const, senderId: callerAgentId }
        : { senderType: 'user' as const }),
    });

    return {
      success: true,
      delegated: true,
      channelId: channel.channelId,
      agentId,
      taskName: channel.name,
      messageId: sent.messageId,
      note: 'Task delegated. Each response from the sub-agent will be automatically forwarded back here.',
    };
  },
};
