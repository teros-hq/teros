/**
 * Usage Service
 *
 * Tracks token usage and costs per conversation.
 * Provides real-time budget calculations for UI visualization.
 *
 * Key responsibilities:
 * - Store and update conversation usage in MongoDB
 * - Calculate token budgets from usage data
 * - Compute costs based on model pricing
 */

import { estimateTokens } from '@teros/shared';
import type { Collection, Db } from 'mongodb';
import type {
  ConversationUsage,
  Model,
  TokenBreakdown,
  TokenBudget,
  UsageWindow,
} from '../types/database';

/**
 * LLM response usage data
 * This is what we receive from the LLM API after each call
 */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Breakdown update data
 * Used to update specific categories of the token breakdown
 */
export interface BreakdownUpdate {
  system?: number;
  tools?: number;
  examples?: number;
  memory?: number;
  summary?: number;
  conversation?: number;
  toolCalls?: number;
  toolResults?: number;
  output?: number;
}

/**
 * Context for denormalization - passed when updating usage
 */
export interface UsageContext {
  userId?: string;
  agentId?: string;
  workspaceId?: string;
}

export class UsageService {
  private usageCollection: Collection<ConversationUsage>;
  private modelsCollection: Collection<Model>;
  private windowsCollection: Collection<UsageWindow>;

  constructor(private db: Db) {
    this.usageCollection = db.collection<ConversationUsage>('conversation_usage');
    this.modelsCollection = db.collection<Model>('models');
    this.windowsCollection = db.collection<UsageWindow>('usage_windows');
  }

  /**
   * Initialize indexes for the usage collections
   */
  async initializeIndexes(): Promise<void> {
    // Conversation usage indexes
    await this.usageCollection.createIndex({ channelId: 1 }, { unique: true });
    await this.usageCollection.createIndex({ lastUpdated: -1 });
    // New indexes for aggregation queries
    await this.usageCollection.createIndex({ userId: 1, lastUpdated: -1 });
    await this.usageCollection.createIndex({ agentId: 1, lastUpdated: -1 });
    await this.usageCollection.createIndex({ workspaceId: 1, lastUpdated: -1 });
    await this.usageCollection.createIndex({ provider: 1, lastUpdated: -1 });

    // Usage windows indexes (for subscription tracking)
    await this.windowsCollection.createIndex({ windowId: 1 }, { unique: true });
    await this.windowsCollection.createIndex({ accountId: 1, windowStart: -1 });
    await this.windowsCollection.createIndex({ windowEnd: 1 }); // For cleanup of old windows
  }

  /**
   * Helper to find model by modelId
   */
  private async findModel(modelId: string) {
    return this.modelsCollection.findOne({ modelId });
  }

  /**
   * Get or create usage record for a conversation
   */
  async getOrCreateUsage(channelId: string, modelId: string): Promise<ConversationUsage> {
    const existing = await this.usageCollection.findOne({ channelId });

    if (existing) {
      // If model changed, update it
      if (existing.modelId !== modelId) {
        const model = await this.findModel(modelId);
        if (model) {
          await this.usageCollection.updateOne(
            { channelId },
            {
              $set: {
                modelId: model.modelId,
                contextLimit: model.context.maxTokens,
                lastUpdated: new Date().toISOString(),
              },
            },
          );
          existing.modelId = model.modelId;
          existing.contextLimit = model.context.maxTokens;
        }
      }
      return existing;
    }

    // Get model for context limit
    const model = await this.findModel(modelId);
    if (!model) {
      console.warn(`[UsageService] Model ${modelId} not found, using defaults`);
      // Use defaults if model not found
      const now = new Date().toISOString();
      const newUsage: ConversationUsage = {
        channelId,
        modelId,
        contextLimit: 200000,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        breakdown: { system: 0, tools: 0, examples: 0, memory: 0, summary: 0, conversation: 0 },
        cost: 0,
        callCount: 0,
        lastUpdated: now,
        createdAt: now,
      };
      await this.usageCollection.insertOne(newUsage);
      return newUsage;
    }

    const now = new Date().toISOString();
    const newUsage: ConversationUsage = {
      channelId,
      modelId,
      contextLimit: model.context.maxTokens,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      breakdown: {
        system: 0,
        tools: 0,
        examples: 0,
        memory: 0,
        summary: 0,
        conversation: 0,
      },
      cost: 0,
      callCount: 0,
      lastUpdated: now,
      createdAt: now,
    };

    await this.usageCollection.insertOne(newUsage);
    return newUsage;
  }

  /**
   * Update usage after an LLM call
   *
   * @param channelId - Conversation/channel ID
   * @param modelId - Model used for this call
   * @param usage - Token usage from LLM response
   * @param breakdownUpdate - Optional updates to breakdown categories
   * @param context - Optional context for denormalization (userId, agentId, workspaceId)
   */
  async updateUsage(
    channelId: string,
    modelId: string,
    usage: LLMUsage,
    breakdownUpdate?: BreakdownUpdate,
    context?: UsageContext,
  ): Promise<ConversationUsage> {
    // Get model for cost calculation and billing type
    const model = await this.findModel(modelId);
    if (!model) {
      console.warn(`[UsageService] Model ${modelId} not found, skipping cost calculation`);
    }

    // Use model data or defaults
    const resolvedModelId = model?.modelId || modelId;
    const contextLimit = model?.context?.maxTokens || 200000;
    const provider = model?.provider || 'unknown';
    // Infer billingType from provider if not explicitly set
    const billingType =
      model?.billingType || (provider.includes('oauth') ? 'subscription' : 'usage');

    // Calculate cost for this call (only for usage-based billing)
    const callCost = model && billingType === 'usage' ? this.calculateCost(usage, model) : 0;

    // Total tokens for this call (input + output)
    const totalTokens = usage.inputTokens + usage.outputTokens;

    // Build update document
    const updateDoc: any = {
      $inc: {
        'tokens.input': usage.inputTokens,
        'tokens.output': usage.outputTokens,
        'tokens.cacheRead': usage.cacheReadTokens || 0,
        'tokens.cacheWrite': usage.cacheWriteTokens || 0,
        cost: callCost,
        callCount: 1,
      },
      $set: {
        modelId,
        contextLimit,
        provider,
        lastUpdated: new Date().toISOString(),
        // Store last call's input tokens for budget visualization
        // This represents the current context window usage
        lastContextTokens: usage.inputTokens,
      },
    };

    // Add denormalized context fields if provided
    if (context?.userId) {
      updateDoc.$set.userId = context.userId;
    }
    if (context?.agentId) {
      updateDoc.$set.agentId = context.agentId;
    }
    if (context?.workspaceId) {
      updateDoc.$set.workspaceId = context.workspaceId;
    }

    // Update breakdown if provided
    if (breakdownUpdate) {
      if (breakdownUpdate.system !== undefined) {
        updateDoc.$set['breakdown.system'] = breakdownUpdate.system;
      }
      if (breakdownUpdate.tools !== undefined) {
        updateDoc.$set['breakdown.tools'] = breakdownUpdate.tools;
      }
      if (breakdownUpdate.examples !== undefined) {
        updateDoc.$set['breakdown.examples'] = breakdownUpdate.examples;
      }
      if (breakdownUpdate.memory !== undefined) {
        updateDoc.$set['breakdown.memory'] = breakdownUpdate.memory;
      }
      if (breakdownUpdate.summary !== undefined) {
        updateDoc.$set['breakdown.summary'] = breakdownUpdate.summary;
      }
      if (breakdownUpdate.conversation !== undefined) {
        updateDoc.$set['breakdown.conversation'] = breakdownUpdate.conversation;
      }
      if (breakdownUpdate.toolCalls !== undefined) {
        updateDoc.$set['breakdown.toolCalls'] = breakdownUpdate.toolCalls;
      }
      if (breakdownUpdate.toolResults !== undefined) {
        updateDoc.$set['breakdown.toolResults'] = breakdownUpdate.toolResults;
      }
      if (breakdownUpdate.output !== undefined) {
        updateDoc.$set['breakdown.output'] = breakdownUpdate.output;
      }
    }

    // Upsert the usage record
    const result = await this.usageCollection.findOneAndUpdate({ channelId }, updateDoc, {
      upsert: true,
      returnDocument: 'after',
    });

    // If it was an insert (new record), set initial values
    if (!result) {
      return this.getOrCreateUsage(channelId, modelId);
    }

    // For subscription models, also update the usage window
    if (model && billingType === 'subscription' && model.quota) {
      await this.updateUsageWindow(provider, totalTokens, model.quota, context);
    }

    return result;
  }

  /**
   * Update usage window for subscription models
   * Tracks token consumption within rolling windows (e.g., 5h for Claude Max)
   */
  private async updateUsageWindow(
    provider: string,
    tokens: number,
    quota: NonNullable<Model['quota']>,
    context?: UsageContext,
  ): Promise<void> {
    const now = new Date();
    const windowHours = quota.windowHours || 5;
    const windowMs = windowHours * 60 * 60 * 1000;

    // Calculate current window start (aligned to window boundaries)
    const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs);
    const windowEnd = new Date(windowStartMs + windowMs);

    // Account ID groups all usage for this provider (could be per-OAuth-account in future)
    const accountId = `${provider}-default`;
    const windowId = `${accountId}-${windowStart.toISOString()}`;

    // Build update document
    const updateDoc: any = {
      $inc: {
        tokensUsed: tokens,
      },
      $set: {
        accountId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        windowHours,
        tokenLimit: quota.tokensPerWindow,
        lastUpdated: now.toISOString(),
      },
      $setOnInsert: {
        windowId,
      },
    };

    // Track by user/agent if context provided
    if (context?.userId) {
      updateDoc.$inc[`byUser.${context.userId}`] = tokens;
    }
    if (context?.agentId) {
      updateDoc.$inc[`byAgent.${context.agentId}`] = tokens;
    }

    await this.windowsCollection.updateOne({ windowId }, updateDoc, { upsert: true });

    // Update percentUsed after the increment
    await this.windowsCollection.updateOne({ windowId }, [
      {
        $set: {
          percentUsed: {
            $multiply: [{ $divide: ['$tokensUsed', '$tokenLimit'] }, 100],
          },
        },
      },
    ]);
  }

  /**
   * Get current usage window for a subscription provider
   * Returns null if no active window exists
   */
  async getCurrentWindow(provider: string): Promise<UsageWindow | null> {
    const accountId = `${provider}-default`;
    const now = new Date();

    return this.windowsCollection.findOne(
      {
        accountId,
        windowEnd: { $gt: now.toISOString() },
      },
      {
        sort: { windowStart: -1 },
      },
    );
  }

  /**
   * Get quota status for a subscription provider
   * Returns current window usage and remaining quota
   */
  async getQuotaStatus(
    provider: string,
    quota: NonNullable<Model['quota']>,
  ): Promise<{
    windowStart: string;
    windowEnd: string;
    tokensUsed: number;
    tokenLimit: number;
    percentUsed: number;
    tokensRemaining: number;
    isNearLimit: boolean;
  } | null> {
    const window = await this.getCurrentWindow(provider);

    if (!window) {
      // No usage in current window
      const now = new Date();
      const windowHours = quota.windowHours || 5;
      const windowMs = windowHours * 60 * 60 * 1000;
      const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;

      return {
        windowStart: new Date(windowStartMs).toISOString(),
        windowEnd: new Date(windowStartMs + windowMs).toISOString(),
        tokensUsed: 0,
        tokenLimit: quota.tokensPerWindow,
        percentUsed: 0,
        tokensRemaining: quota.tokensPerWindow,
        isNearLimit: false,
      };
    }

    const alertThreshold = quota.alertAt || 0.8;

    return {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      tokensUsed: window.tokensUsed,
      tokenLimit: window.tokenLimit,
      percentUsed: window.percentUsed,
      tokensRemaining: Math.max(0, window.tokenLimit - window.tokensUsed),
      isNearLimit: window.percentUsed >= alertThreshold * 100,
    };
  }

  /**
   * Update the token breakdown for a conversation
   * Used to track system prompt, tools, memory, and conversation tokens
   */
  async updateBreakdown(channelId: string, breakdown: Partial<TokenBreakdown>): Promise<void> {
    const updateDoc: any = {
      $set: {
        lastUpdated: new Date().toISOString(),
      },
    };

    if (breakdown.system !== undefined) {
      updateDoc.$set['breakdown.system'] = breakdown.system;
    }
    if (breakdown.tools !== undefined) {
      updateDoc.$set['breakdown.tools'] = breakdown.tools;
    }
    if (breakdown.examples !== undefined) {
      updateDoc.$set['breakdown.examples'] = breakdown.examples;
    }
    if (breakdown.memory !== undefined) {
      updateDoc.$set['breakdown.memory'] = breakdown.memory;
    }
    if (breakdown.summary !== undefined) {
      updateDoc.$set['breakdown.summary'] = breakdown.summary;
    }
    if (breakdown.conversation !== undefined) {
      updateDoc.$set['breakdown.conversation'] = breakdown.conversation;
    }

    await this.usageCollection.updateOne({ channelId }, updateDoc);
  }

  /**
   * Calculate the token budget for a conversation
   * Returns the data needed for UI visualization
   *
   * IMPORTANT: This shows CURRENT context window usage, not accumulated totals.
   * - totalUsed = tokens in the current context window (input + output of last call)
   * - breakdown = distribution of those tokens by category (scaled to real Anthropic counts)
   * - cost.tokens = accumulated totals for billing (sum of all calls)
   */
  async calculateBudget(channelId: string): Promise<TokenBudget | null> {
    const usage = await this.usageCollection.findOne({ channelId });
    if (!usage) {
      return null;
    }

    // lastContextTokens = inputTokens from the last LLM call (real Anthropic count)
    // This represents the current context window size
    const lastContextTokens = (usage as any).lastContextTokens || 0;

    const breakdown = usage.breakdown || {
      system: 0,
      tools: 0,
      examples: 0,
      memory: 0,
      summary: 0,
      conversation: 0,
      toolCalls: 0,
      toolResults: 0,
      output: 0,
    };

    // Calculate total from breakdown (now scaled to real tokens from Anthropic)
    // The breakdown is calculated in ConversationManager using real inputTokens
    const breakdownInputTotal =
      breakdown.system +
      breakdown.tools +
      (breakdown.examples || 0) +
      breakdown.memory +
      (breakdown.summary || 0) +
      breakdown.conversation +
      (breakdown.toolCalls || 0) +
      (breakdown.toolResults || 0);

    // Total context = input tokens + output tokens (what's in the context window)
    const outputTokens = breakdown.output || 0;
    const totalUsed =
      breakdownInputTotal > 0
        ? breakdownInputTotal + outputTokens // Use scaled breakdown + output
        : lastContextTokens; // Fallback to raw lastContextTokens

    // If using fallback (no breakdown), put it all in conversation
    const effectiveBreakdown =
      breakdownInputTotal > 0
        ? breakdown
        : {
            system: 0,
            tools: 0,
            examples: 0,
            memory: 0,
            summary: 0,
            conversation: lastContextTokens,
            toolCalls: 0,
            toolResults: 0,
            output: 0,
          };

    const contextLimit = usage.contextLimit || 200000;
    const percentUsed =
      contextLimit > 0
        ? Math.round((totalUsed / contextLimit) * 100 * 10) / 10 // 1 decimal
        : 0;

    return {
      modelLimit: contextLimit,
      totalUsed,
      percentUsed,
      breakdown: effectiveBreakdown,
      cost: {
        // Session cost is the accumulated total (for billing purposes)
        session: usage.cost || 0,
        tokens: {
          // These are ACCUMULATED totals (for billing), not current context
          input: usage.tokens?.input || 0,
          output: usage.tokens?.output || 0,
          cacheRead: usage.tokens?.cacheRead || 0,
          cacheWrite: usage.tokens?.cacheWrite || 0,
        },
        // Number of LLM API calls
        callCount: usage.callCount || 0,
      },
      available: Math.max(0, contextLimit - totalUsed),
    };
  }

  /**
   * Get usage for a conversation
   */
  async getUsage(channelId: string): Promise<ConversationUsage | null> {
    return this.usageCollection.findOne({ channelId });
  }

  /**
   * Delete usage for a conversation (when channel is deleted)
   */
  async deleteUsage(channelId: string): Promise<void> {
    await this.usageCollection.deleteOne({ channelId });
  }

  /**
   * Calculate cost from token usage and model pricing
   * Returns 0 if model has no pricing information
   */
  private calculateCost(usage: LLMUsage, model: Model): number {
    // If model has no cost info, return 0 (e.g., OAuth models with subscription)
    if (!model.cost) {
      return 0;
    }

    const inputCost = (usage.inputTokens * model.cost.input) / 1_000_000;
    const outputCost = (usage.outputTokens * model.cost.output) / 1_000_000;
    const cacheReadCost = model.cost.cacheRead
      ? ((usage.cacheReadTokens || 0) * model.cost.cacheRead) / 1_000_000
      : 0;
    const cacheWriteCost = model.cost.cacheWrite
      ? ((usage.cacheWriteTokens || 0) * model.cost.cacheWrite) / 1_000_000
      : 0;

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /**
   * Estimate breakdown from conversation content
   * Used when we need to calculate breakdown without actual token counts
   */
  estimateBreakdown(
    systemPrompt: string,
    toolDescriptions: string,
    examples: string,
    memoryContext: string,
    summary: string,
    conversationHistory: string,
  ): TokenBreakdown {
    return {
      system: estimateTokens(systemPrompt),
      tools: estimateTokens(toolDescriptions),
      examples: estimateTokens(examples),
      memory: estimateTokens(memoryContext),
      summary: estimateTokens(summary),
      conversation: estimateTokens(conversationHistory),
    };
  }

  /**
   * Get aggregated usage statistics for a user
   * Useful for showing total costs across all conversations
   */
  async getUserStats(
    userId: string,
    channelIds: string[],
  ): Promise<{
    totalCost: number;
    totalTokens: {
      input: number;
      output: number;
    };
    conversationCount: number;
  }> {
    const pipeline = [
      { $match: { channelId: { $in: channelIds } } },
      {
        $group: {
          _id: null,
          totalCost: { $sum: '$cost' },
          totalInputTokens: { $sum: '$tokens.input' },
          totalOutputTokens: { $sum: '$tokens.output' },
          conversationCount: { $sum: 1 },
        },
      },
    ];

    const result = await this.usageCollection.aggregate(pipeline).toArray();

    if (result.length === 0) {
      return {
        totalCost: 0,
        totalTokens: { input: 0, output: 0 },
        conversationCount: 0,
      };
    }

    return {
      totalCost: result[0].totalCost,
      totalTokens: {
        input: result[0].totalInputTokens,
        output: result[0].totalOutputTokens,
      },
      conversationCount: result[0].conversationCount,
    };
  }

  // ============================================================================
  // AGGREGATION METHODS (for admin dashboard)
  // ============================================================================

  /**
   * Get usage aggregated by user
   */
  async getUsageByUser(options?: { from?: Date; to?: Date; limit?: number }): Promise<
    Array<{
      userId: string;
      totalCost: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      conversationCount: number;
      callCount: number;
    }>
  > {
    const match: any = { userId: { $exists: true, $ne: null } };

    if (options?.from || options?.to) {
      match.lastUpdated = {};
      if (options.from) match.lastUpdated.$gte = options.from.toISOString();
      if (options.to) match.lastUpdated.$lte = options.to.toISOString();
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: '$userId',
          totalCost: { $sum: '$cost' },
          inputTokens: { $sum: '$tokens.input' },
          outputTokens: { $sum: '$tokens.output' },
          conversationCount: { $sum: 1 },
          callCount: { $sum: '$callCount' },
        },
      },
      {
        $project: {
          userId: '$_id',
          totalCost: 1,
          totalTokens: { $add: ['$inputTokens', '$outputTokens'] },
          inputTokens: 1,
          outputTokens: 1,
          conversationCount: 1,
          callCount: 1,
        },
      },
      { $sort: { totalCost: -1 } },
      ...(options?.limit ? [{ $limit: options.limit }] : []),
    ];

    return this.usageCollection.aggregate(pipeline).toArray() as any;
  }

  /**
   * Get usage aggregated by agent
   */
  async getUsageByAgent(options?: { from?: Date; to?: Date; limit?: number }): Promise<
    Array<{
      agentId: string;
      totalCost: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      conversationCount: number;
      callCount: number;
    }>
  > {
    const match: any = { agentId: { $exists: true, $ne: null } };

    if (options?.from || options?.to) {
      match.lastUpdated = {};
      if (options.from) match.lastUpdated.$gte = options.from.toISOString();
      if (options.to) match.lastUpdated.$lte = options.to.toISOString();
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: '$agentId',
          totalCost: { $sum: '$cost' },
          inputTokens: { $sum: '$tokens.input' },
          outputTokens: { $sum: '$tokens.output' },
          conversationCount: { $sum: 1 },
          callCount: { $sum: '$callCount' },
        },
      },
      {
        $project: {
          agentId: '$_id',
          totalCost: 1,
          totalTokens: { $add: ['$inputTokens', '$outputTokens'] },
          inputTokens: 1,
          outputTokens: 1,
          conversationCount: 1,
          callCount: 1,
        },
      },
      { $sort: { totalCost: -1 } },
      ...(options?.limit ? [{ $limit: options.limit }] : []),
    ];

    return this.usageCollection.aggregate(pipeline).toArray() as any;
  }

  /**
   * Get usage aggregated by model/provider
   */
  async getUsageByModel(options?: { from?: Date; to?: Date }): Promise<
    Array<{
      modelId: string;
      provider: string;
      totalCost: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      conversationCount: number;
      callCount: number;
    }>
  > {
    const match: any = {};

    if (options?.from || options?.to) {
      match.lastUpdated = {};
      if (options.from) match.lastUpdated.$gte = options.from.toISOString();
      if (options.to) match.lastUpdated.$lte = options.to.toISOString();
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { modelId: '$modelId', provider: '$provider' },
          totalCost: { $sum: '$cost' },
          inputTokens: { $sum: '$tokens.input' },
          outputTokens: { $sum: '$tokens.output' },
          cacheReadTokens: { $sum: '$tokens.cacheRead' },
          cacheWriteTokens: { $sum: '$tokens.cacheWrite' },
          conversationCount: { $sum: 1 },
          callCount: { $sum: '$callCount' },
        },
      },
      {
        $project: {
          modelId: '$_id.modelId',
          provider: '$_id.provider',
          totalCost: 1,
          totalTokens: { $add: ['$inputTokens', '$outputTokens'] },
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          conversationCount: 1,
          callCount: 1,
        },
      },
      { $sort: { totalCost: -1 } },
    ];

    return this.usageCollection.aggregate(pipeline).toArray() as any;
  }

  /**
   * Get total usage summary
   */
  async getTotalUsage(options?: { from?: Date; to?: Date }): Promise<{
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    conversationCount: number;
    callCount: number;
    uniqueUsers: number;
    uniqueAgents: number;
  }> {
    const match: any = {};

    if (options?.from || options?.to) {
      match.lastUpdated = {};
      if (options.from) match.lastUpdated.$gte = options.from.toISOString();
      if (options.to) match.lastUpdated.$lte = options.to.toISOString();
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: null,
          totalCost: { $sum: '$cost' },
          inputTokens: { $sum: '$tokens.input' },
          outputTokens: { $sum: '$tokens.output' },
          cacheReadTokens: { $sum: '$tokens.cacheRead' },
          cacheWriteTokens: { $sum: '$tokens.cacheWrite' },
          conversationCount: { $sum: 1 },
          callCount: { $sum: '$callCount' },
          users: { $addToSet: '$userId' },
          agents: { $addToSet: '$agentId' },
        },
      },
      {
        $project: {
          totalCost: 1,
          totalTokens: { $add: ['$inputTokens', '$outputTokens'] },
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          conversationCount: 1,
          callCount: 1,
          uniqueUsers: { $size: { $filter: { input: '$users', cond: { $ne: ['$this', null] } } } },
          uniqueAgents: {
            $size: { $filter: { input: '$agents', cond: { $ne: ['$this', null] } } },
          },
        },
      },
    ];

    const result = await this.usageCollection.aggregate(pipeline).toArray();

    if (result.length === 0) {
      return {
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        conversationCount: 0,
        callCount: 0,
        uniqueUsers: 0,
        uniqueAgents: 0,
      };
    }

    return result[0] as any;
  }

  /**
   * Clean up old usage windows (older than 7 days)
   */
  async cleanupOldWindows(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.windowsCollection.deleteMany({
      windowEnd: { $lt: cutoff.toISOString() },
    });
    return result.deletedCount;
  }
}
