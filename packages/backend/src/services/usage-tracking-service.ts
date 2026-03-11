/**
 * Usage Tracking Service
 *
 * Centralized service for tracking LLM usage, costs, and generating analytics.
 * Every LLM generation is logged to enable billing, cost optimization, and accountability.
 *
 * Features:
 * - Track usage per user, workspace, agent, conversation
 * - Calculate costs based on model pricing
 * - Generate usage reports and analytics
 * - Support for multiple providers (OpenRouter, Anthropic, OpenAI, etc.)
 */

import { generateId } from '@teros/core';
import type { Collection, Db } from 'mongodb';
import type { LLMUsage, Model } from '../types/database';

export interface TrackUsageParams {
  // Context
  userId: string;
  workspaceId?: string;
  organizationId?: string;
  agentId: string;
  coreId: string;
  channelId: string;
  messageId: string;
  step?: number;

  // Model info
  provider: LLMUsage['provider'];
  modelId: string;
  modelString: string;
  actualModel?: string;
  providerMetadata?: Record<string, any>;

  // Token usage
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;

  // Generation details
  generationId?: string;
  parameters?: Record<string, any>;
  stopReason?: 'end_turn' | 'tool_calls' | 'max_tokens' | 'error';
  toolCallsCount?: number;
  latencyMs?: number;

  // Optional metadata
  tags?: string[];
  notes?: string;
}

export class UsageTrackingService {
  private db: Db;
  private usageCollection: Collection<LLMUsage>;
  private modelsCollection: Collection<Model>;

  constructor(db: Db) {
    this.db = db;
    this.usageCollection = db.collection<LLMUsage>('llm_usage');
    this.modelsCollection = db.collection<Model>('models');
  }

  /**
   * Track a single LLM generation
   *
   * Calculates costs based on model pricing and saves to database.
   */
  async trackUsage(params: TrackUsageParams): Promise<LLMUsage> {
    // Get model info for pricing
    const model = await this.modelsCollection.findOne({ modelId: params.modelId });

    if (!model) {
      console.warn(`[UsageTracking] Model not found: ${params.modelId}`);
      // Continue anyway - we'll use zero costs
    }

    // Calculate costs
    const costs = this.calculateCosts(
      {
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        cacheReadTokens: params.cacheReadTokens,
        cacheWriteTokens: params.cacheWriteTokens,
        reasoningTokens: params.reasoningTokens,
      },
      model?.cost,
    );

    // Create usage record
    const usage: LLMUsage = {
      usageId: generateId('usage'),
      generationId: params.generationId,
      timestamp: new Date(),

      // Context
      userId: params.userId,
      workspaceId: params.workspaceId,
      organizationId: params.organizationId,
      agentId: params.agentId,
      coreId: params.coreId,
      channelId: params.channelId,
      messageId: params.messageId,
      step: params.step,

      // Model
      provider: params.provider,
      modelId: params.modelId,
      modelString: params.modelString,
      actualModel: params.actualModel,
      providerMetadata: params.providerMetadata,

      // Tokens
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      reasoningTokens: params.reasoningTokens,

      // Costs
      costInput: costs.input,
      costOutput: costs.output,
      costCacheRead: costs.cacheRead,
      costCacheWrite: costs.cacheWrite,
      costReasoning: costs.reasoning,
      costRequest: costs.request,
      costTotal: costs.total,
      currency: 'USD',

      // Generation details
      parameters: params.parameters,
      stopReason: params.stopReason,
      toolCallsCount: params.toolCallsCount,
      latencyMs: params.latencyMs,

      // Metadata
      billingType: model?.billingType,
      tags: params.tags,
      notes: params.notes,
      createdAt: new Date(),
    };

    // Save to database
    try {
      await this.usageCollection.insertOne(usage);
      console.log(
        `[UsageTracking] Tracked usage: ${usage.usageId} | ${params.provider}:${params.modelId} | ${costs.total.toFixed(6)} USD`,
      );
    } catch (error) {
      console.error('[UsageTracking] Failed to save usage:', error);
      // Don't throw - we don't want to break the LLM call if tracking fails
    }

    return usage;
  }

  /**
   * Calculate costs based on token usage and model pricing
   */
  private calculateCosts(
    tokens: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
    },
    pricing?: Model['cost'],
  ): {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    request?: number;
    total: number;
  } {
    if (!pricing) {
      return {
        input: 0,
        output: 0,
        total: 0,
      };
    }

    // Costs per million tokens
    const costInput = (tokens.promptTokens / 1_000_000) * pricing.input;
    const costOutput = (tokens.completionTokens / 1_000_000) * pricing.output;

    const costCacheRead =
      tokens.cacheReadTokens && pricing.cacheRead
        ? (tokens.cacheReadTokens / 1_000_000) * pricing.cacheRead
        : undefined;

    const costCacheWrite =
      tokens.cacheWriteTokens && pricing.cacheWrite
        ? (tokens.cacheWriteTokens / 1_000_000) * pricing.cacheWrite
        : undefined;

    // Reasoning tokens typically cost the same as output tokens
    // but some models may have different pricing
    const costReasoning = tokens.reasoningTokens
      ? (tokens.reasoningTokens / 1_000_000) * pricing.output
      : undefined;

    const total =
      costInput + costOutput + (costCacheRead || 0) + (costCacheWrite || 0) + (costReasoning || 0);

    return {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      reasoning: costReasoning,
      total,
    };
  }

  /**
   * Get usage summary for a time period
   */
  async getUsageSummary(params: {
    userId?: string;
    workspaceId?: string;
    organizationId?: string;
    agentId?: string;
    from?: Date;
    to?: Date;
  }): Promise<{
    totalCost: number;
    totalTokens: number;
    totalGenerations: number;
    byProvider: Record<string, { cost: number; tokens: number; generations: number }>;
    byModel: Record<string, { cost: number; tokens: number; generations: number }>;
  }> {
    const filter: any = {};

    if (params.userId) filter.userId = params.userId;
    if (params.workspaceId) filter.workspaceId = params.workspaceId;
    if (params.organizationId) filter.organizationId = params.organizationId;
    if (params.agentId) filter.agentId = params.agentId;

    if (params.from || params.to) {
      filter.timestamp = {};
      if (params.from) filter.timestamp.$gte = params.from;
      if (params.to) filter.timestamp.$lte = params.to;
    }

    const usages = await this.usageCollection.find(filter).toArray();

    const summary = {
      totalCost: 0,
      totalTokens: 0,
      totalGenerations: usages.length,
      byProvider: {} as Record<string, { cost: number; tokens: number; generations: number }>,
      byModel: {} as Record<string, { cost: number; tokens: number; generations: number }>,
    };

    for (const usage of usages) {
      summary.totalCost += usage.costTotal;
      summary.totalTokens += usage.totalTokens;

      // By provider
      if (!summary.byProvider[usage.provider]) {
        summary.byProvider[usage.provider] = { cost: 0, tokens: 0, generations: 0 };
      }
      summary.byProvider[usage.provider].cost += usage.costTotal;
      summary.byProvider[usage.provider].tokens += usage.totalTokens;
      summary.byProvider[usage.provider].generations += 1;

      // By model
      if (!summary.byModel[usage.modelId]) {
        summary.byModel[usage.modelId] = { cost: 0, tokens: 0, generations: 0 };
      }
      summary.byModel[usage.modelId].cost += usage.costTotal;
      summary.byModel[usage.modelId].tokens += usage.totalTokens;
      summary.byModel[usage.modelId].generations += 1;
    }

    return summary;
  }

  /**
   * Get most expensive conversations
   */
  async getMostExpensiveConversations(params: {
    userId?: string;
    workspaceId?: string;
    limit?: number;
    from?: Date;
    to?: Date;
  }): Promise<
    Array<{
      channelId: string;
      totalCost: number;
      totalTokens: number;
      generationsCount: number;
    }>
  > {
    const filter: any = {};

    if (params.userId) filter.userId = params.userId;
    if (params.workspaceId) filter.workspaceId = params.workspaceId;

    if (params.from || params.to) {
      filter.timestamp = {};
      if (params.from) filter.timestamp.$gte = params.from;
      if (params.to) filter.timestamp.$lte = params.to;
    }

    const result = await this.usageCollection
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$channelId',
            totalCost: { $sum: '$costTotal' },
            totalTokens: { $sum: '$totalTokens' },
            generationsCount: { $sum: 1 },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: params.limit || 10 },
      ])
      .toArray();

    return result.map((r) => ({
      channelId: r._id,
      totalCost: r.totalCost,
      totalTokens: r.totalTokens,
      generationsCount: r.generationsCount,
    }));
  }
}
