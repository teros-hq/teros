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

import { estimateCostBreakdownUsd, generateId } from '@teros/core';
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

  /**
   * FK to agent_usage_sessions.sessionUsageId. Set when the LLM call ran
   * inside an instrumented turn so analytics can group N llm_usage rows under
   * the same session.
   */
  sessionUsageId?: string;

  // Model info
  provider: LLMUsage['provider'];
  modelId: string;
  modelString: string;
  actualModel?: string;
  /** Real upstream provider (`fireworks` | `together` | …); telemetry dimension. TER-615 / C1. */
  actualProvider?: string;
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
  /** Time-to-first-token in ms (client-side wall clock). TER-615. */
  ttftMs?: number;
  /** Failover telemetry (TER-617/F3). */
  fallbackUsed?: boolean;
  primaryErrorClass?: string;

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
    // Get model info for billingType (the `models.cost` column is unpopulated —
    // pricing comes from the shared `estimateCostBreakdownUsd`, the SAME source
    // the session projection uses, so llm_usage.costTotal and
    // agent_usage_sessions.costUsd can never disagree). A2.4.
    const model = await this.modelsCollection.findOne({ modelId: params.modelId });

    if (!model) {
      console.warn(`[UsageTracking] Model not found: ${params.modelId}`);
      // Continue anyway — cost still resolves from the owned pricing table.
    }

    // One cost source. `null` = subscription plan or no verified price → 0 in the
    // schema (non-nullable), consistent with the session path's `cost ?? 0`; the
    // UI distinguishes tokens>0 & cost==0 as "not priced"/"Subscription".
    const breakdown = estimateCostBreakdownUsd({
      provider: params.provider,
      modelId: params.actualModel || params.modelId,
      inputTokens: params.promptTokens,
      outputTokens: params.completionTokens,
      cachedReadTokens: params.cacheReadTokens,
      cachedWriteTokens: params.cacheWriteTokens,
      billingType: model?.billingType,
    });
    const costs = {
      input: breakdown?.input ?? 0,
      output: breakdown?.output ?? 0,
      cacheRead: breakdown?.cacheRead,
      cacheWrite: breakdown?.cacheWrite,
      total: breakdown?.total ?? 0,
    };

    // Create usage record
    const usage: LLMUsage = {
      usageId: generateId('usage'),
      generationId: params.generationId,
      sessionUsageId: params.sessionUsageId,
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
      actualProvider: params.actualProvider,
      providerMetadata: params.providerMetadata,

      // Tokens
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      reasoningTokens: params.reasoningTokens,

      // Costs. costReasoning/costRequest intentionally unset: reasoning tokens are
      // a subset of output and already priced by the output rate (the old
      // calculateCosts double-charged them), and the owned pricing has no
      // per-request fee. A2.1 / A2.4.
      costInput: costs.input,
      costOutput: costs.output,
      costCacheRead: costs.cacheRead,
      costCacheWrite: costs.cacheWrite,
      costTotal: costs.total,
      currency: 'USD',

      // Generation details
      parameters: params.parameters,
      stopReason: params.stopReason,
      toolCallsCount: params.toolCallsCount,
      latencyMs: params.latencyMs,
      ttftMs: params.ttftMs,
      fallbackUsed: params.fallbackUsed,
      primaryErrorClass: params.primaryErrorClass,

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
