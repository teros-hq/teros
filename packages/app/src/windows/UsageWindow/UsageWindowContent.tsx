/**
 * Usage Window Content
 *
 * Dashboard for LLM usage analytics and cost tracking:
 * - Overall summary with key metrics
 * - Timeline chart showing usage over time
 * - Top lists (users, workspaces, agents, models)
 * - Most expensive conversations
 * - Filtering by period
 */

import {
  BarChart3,
  Bot,
  Calendar,
  Cpu,
  DollarSign,
  Layers,
  MessageSquare,
  RefreshCw,
  TrendingUp,
  Users,
  Zap,
} from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { Button, ScrollView, Separator, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

type Period = 'hour' | 'day' | 'week' | 'month';

interface UsageSummary {
  totalGenerations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  totalInputCost: number;
  totalOutputCost: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

interface TopItem {
  _id: string | { provider: string; model: string };
  generations: number;
  totalTokens: number;
  totalCost: number;
}

interface TimelinePoint {
  _id: string;
  generations: number;
  totalTokens: number;
  totalCost: number;
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'hour', label: 'Last Hour' },
  { value: 'day', label: 'Last 24h' },
  { value: 'week', label: 'Last Week' },
  { value: 'month', label: 'Last Month' },
];

function MetricCard({
  icon: Icon,
  label,
  value,
  subtitle,
  color = '#3B82F6',
}: {
  icon: any;
  label: string;
  value: string;
  subtitle?: string;
  color?: string;
}) {
  return (
    <YStack
      flex={1}
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$3"
      borderWidth={1}
      borderColor="rgba(39, 39, 42, 0.5)"
      padding="$4"
      gap="$2"
    >
      <XStack alignItems="center" gap="$2">
        <Icon size={20} color={color} />
        <Text fontSize="$2" color="$gray11" fontWeight="500">
          {label}
        </Text>
      </XStack>
      <Text fontSize="$7" fontWeight="700" color="$gray12">
        {value}
      </Text>
      {subtitle && (
        <Text fontSize="$1" color="$gray11">
          {subtitle}
        </Text>
      )}
    </YStack>
  );
}

function TopListCard({
  title,
  icon: Icon,
  items,
  renderItem,
  emptyMessage = 'No data available',
}: {
  title: string;
  icon: any;
  items: TopItem[];
  renderItem: (item: TopItem, index: number) => React.ReactNode;
  emptyMessage?: string;
}) {
  return (
    <YStack
      flex={1}
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$3"
      borderWidth={1}
      borderColor="rgba(39, 39, 42, 0.5)"
      overflow="hidden"
    >
      {/* Header */}
      <XStack
        alignItems="center"
        gap="$2"
        padding="$3"
        backgroundColor="rgba(39, 39, 42, 0.3)"
        borderBottomWidth={1}
        borderBottomColor="rgba(39, 39, 42, 0.5)"
      >
        <Icon size={18} color="$gray11" />
        <Text fontSize="$3" fontWeight="600" color="$gray12">
          {title}
        </Text>
      </XStack>

      {/* Content */}
      <YStack padding="$3" gap="$2" minHeight={200}>
        {items.length === 0 ? (
          <YStack flex={1} alignItems="center" justifyContent="center" paddingVertical="$6">
            <Text color="$gray11" fontSize="$2">
              {emptyMessage}
            </Text>
          </YStack>
        ) : (
          items.map((item, index) => (
            <React.Fragment key={index}>
              {renderItem(item, index)}
              {index < items.length - 1 && <Separator borderColor="rgba(39, 39, 42, 0.3)" />}
            </React.Fragment>
          ))
        )}
      </YStack>
    </YStack>
  );
}

export function UsageWindowContent() {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('day');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [topUsers, setTopUsers] = useState<TopItem[]>([]);
  const [topWorkspaces, setTopWorkspaces] = useState<TopItem[]>([]);
  const [topAgents, setTopAgents] = useState<TopItem[]>([]);
  const [topModels, setTopModels] = useState<TopItem[]>([]);
  const [expensiveConversations, setExpensiveConversations] = useState<TopItem[]>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const client = getTerosClient();

      // Load summary
      const summaryRes = await client.get(`/admin/usage/summary?period=${period}`);
      setSummary(summaryRes.summary);

      // Load top lists
      const [usersRes, workspacesRes, agentsRes, modelsRes, conversationsRes, timelineRes] =
        await Promise.all([
          client.get(`/admin/usage/by-user?period=${period}&limit=5`),
          client.get(`/admin/usage/by-workspace?period=${period}&limit=5`),
          client.get(`/admin/usage/by-agent?period=${period}&limit=5`),
          client.get(`/admin/usage/by-model?period=${period}&limit=5`),
          client.get(`/admin/usage/expensive-conversations?period=${period}&limit=5`),
          client.get(
            `/admin/usage/timeline?period=${period}&groupBy=${period === 'hour' ? 'hour' : 'day'}`,
          ),
        ]);

      setTopUsers(usersRes.users || []);
      setTopWorkspaces(workspacesRes.workspaces || []);
      setTopAgents(agentsRes.agents || []);
      setTopModels(modelsRes.models || []);
      setExpensiveConversations(conversationsRes.conversations || []);
      setTimeline(timelineRes.timeline || []);
    } catch (error) {
      console.error('Failed to load usage data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [period]);

  const formatCost = (cost?: number) => {
    const safe = typeof cost === 'number' && !Number.isNaN(cost) ? cost : 0;
    return `${safe.toFixed(4)}`;
  };

  const formatTokens = (tokens?: number) => {
    const t = typeof tokens === 'number' && !Number.isNaN(tokens) ? tokens : 0;
    if (t >= 1000000) {
      return `${(t / 1000000).toFixed(2)}M`;
    }
    if (t >= 1000) {
      return `${(t / 1000).toFixed(1)}K`;
    }
    return t.toString();
  };

  if (loading) {
    return (
      <FullscreenLoader variant="default" label="Loading usage data..." />
    );
  }

  return (
    <ScrollView flex={1} backgroundColor="$background">
      <YStack padding="$4" gap="$4">
        {/* Header with period selector */}
        <XStack alignItems="center" justifyContent="space-between">
          <XStack alignItems="center" gap="$2">
            <BarChart3 size={24} color="$blue10" />
            <Text fontSize="$6" fontWeight="700" color="$gray12">
              Usage & Costs
            </Text>
          </XStack>

          <XStack gap="$2" alignItems="center">
            <Button size="$2" icon={RefreshCw} onPress={loadData} chromeless>
              Refresh
            </Button>

            {PERIOD_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                size="$2"
                onPress={() => setPeriod(opt.value)}
                theme={period === opt.value ? 'blue' : undefined}
                variant={period === opt.value ? 'outlined' : 'outlined'}
              >
                {opt.label}
              </Button>
            ))}
          </XStack>
        </XStack>

        {/* Summary Cards */}
        {summary && (
          <XStack gap="$3" flexWrap="wrap">
            <MetricCard
              icon={DollarSign}
              label="Total Cost"
              value={formatCost(summary.totalCost)}
              subtitle={`Input: ${formatCost(summary.totalInputCost)} | Output: ${formatCost(summary.totalOutputCost)}`}
              color="#22C55E"
            />
            <MetricCard
              icon={Zap}
              label="Total Tokens"
              value={formatTokens(summary.totalTokens)}
              subtitle={`Prompt: ${formatTokens(summary.totalPromptTokens)} | Completion: ${formatTokens(summary.totalCompletionTokens)}`}
              color="#3B82F6"
            />
            <MetricCard
              icon={TrendingUp}
              label="Generations"
              value={(summary.totalGenerations ?? 0).toLocaleString()}
              subtitle={
                summary.totalCacheReadTokens > 0
                  ? `Cache hits: ${formatTokens(summary.totalCacheReadTokens)}`
                  : undefined
              }
              color="#8B5CF6"
            />
          </XStack>
        )}

        {/* Top Lists Grid */}
        <XStack gap="$3" flexWrap="wrap">
          {/* Top Users */}
          <TopListCard
            title="Top Users by Cost"
            icon={Users}
            items={topUsers}
            renderItem={(item, index) => (
              <XStack justifyContent="space-between" alignItems="center" key={index}>
                <XStack gap="$2" alignItems="center" flex={1}>
                  <Text fontSize="$1" color="$gray11" fontWeight="600" width={20}>
                    #{index + 1}
                  </Text>
                  <Text fontSize="$2" color="$gray12" flex={1} numberOfLines={1}>
                    {(item._id as string).slice(0, 16)}...
                  </Text>
                </XStack>
                <XStack gap="$3" alignItems="center">
                  <Text fontSize="$1" color="$gray11">
                    {formatTokens(item.totalTokens)}
                  </Text>
                  <Text
                    fontSize="$2"
                    color="$green10"
                    fontWeight="600"
                    minWidth={60}
                    textAlign="right"
                  >
                    {formatCost(item.totalCost)}
                  </Text>
                </XStack>
              </XStack>
            )}
          />

          {/* Top Workspaces */}
          <TopListCard
            title="Top Workspaces by Cost"
            icon={Layers}
            items={topWorkspaces}
            renderItem={(item, index) => (
              <XStack justifyContent="space-between" alignItems="center" key={index}>
                <XStack gap="$2" alignItems="center" flex={1}>
                  <Text fontSize="$1" color="$gray11" fontWeight="600" width={20}>
                    #{index + 1}
                  </Text>
                  <Text fontSize="$2" color="$gray12" flex={1} numberOfLines={1}>
                    {(item._id as string).slice(0, 16)}...
                  </Text>
                </XStack>
                <XStack gap="$3" alignItems="center">
                  <Text fontSize="$1" color="$gray11">
                    {formatTokens(item.totalTokens)}
                  </Text>
                  <Text
                    fontSize="$2"
                    color="$green10"
                    fontWeight="600"
                    minWidth={60}
                    textAlign="right"
                  >
                    {formatCost(item.totalCost)}
                  </Text>
                </XStack>
              </XStack>
            )}
          />
        </XStack>

        <XStack gap="$3" flexWrap="wrap">
          {/* Top Agents */}
          <TopListCard
            title="Top Agents by Cost"
            icon={Bot}
            items={topAgents}
            renderItem={(item, index) => (
              <XStack justifyContent="space-between" alignItems="center" key={index}>
                <XStack gap="$2" alignItems="center" flex={1}>
                  <Text fontSize="$1" color="$gray11" fontWeight="600" width={20}>
                    #{index + 1}
                  </Text>
                  <Text fontSize="$2" color="$gray12" flex={1} numberOfLines={1}>
                    {(item._id as string).slice(0, 16)}...
                  </Text>
                </XStack>
                <XStack gap="$3" alignItems="center">
                  <Text fontSize="$1" color="$gray11">
                    {item.generations} gen
                  </Text>
                  <Text
                    fontSize="$2"
                    color="$green10"
                    fontWeight="600"
                    minWidth={60}
                    textAlign="right"
                  >
                    {formatCost(item.totalCost)}
                  </Text>
                </XStack>
              </XStack>
            )}
          />

          {/* Top Models */}
          <TopListCard
            title="Top Models by Cost"
            icon={Cpu}
            items={topModels}
            renderItem={(item, index) => {
              const modelInfo = item._id as { provider: string; model: string };
              return (
                <XStack justifyContent="space-between" alignItems="center" key={index}>
                  <XStack gap="$2" alignItems="center" flex={1}>
                    <Text fontSize="$1" color="$gray11" fontWeight="600" width={20}>
                      #{index + 1}
                    </Text>
                    <YStack flex={1}>
                      <Text fontSize="$2" color="$gray12" numberOfLines={1}>
                        {modelInfo.model}
                      </Text>
                      <Text fontSize="$1" color="$gray11">
                        {modelInfo.provider}
                      </Text>
                    </YStack>
                  </XStack>
                  <XStack gap="$3" alignItems="center">
                    <Text fontSize="$1" color="$gray11">
                      {item.generations} gen
                    </Text>
                    <Text
                      fontSize="$2"
                      color="$green10"
                      fontWeight="600"
                      minWidth={60}
                      textAlign="right"
                    >
                      {formatCost(item.totalCost)}
                    </Text>
                  </XStack>
                </XStack>
              );
            }}
          />
        </XStack>

        {/* Most Expensive Conversations */}
        <TopListCard
          title="Most Expensive Conversations"
          icon={MessageSquare}
          items={expensiveConversations}
          renderItem={(item, index) => (
            <XStack justifyContent="space-between" alignItems="center" key={index}>
              <XStack gap="$2" alignItems="center" flex={1}>
                <Text fontSize="$1" color="$gray11" fontWeight="600" width={20}>
                  #{index + 1}
                </Text>
                <Text fontSize="$2" color="$gray12" flex={1} numberOfLines={1}>
                  {(item._id as string).slice(0, 20)}...
                </Text>
              </XStack>
              <XStack gap="$3" alignItems="center">
                <Text fontSize="$1" color="$gray11">
                  {item.generations} msgs
                </Text>
                <Text
                  fontSize="$2"
                  color="$green10"
                  fontWeight="600"
                  minWidth={60}
                  textAlign="right"
                >
                  {formatCost(item.totalCost)}
                </Text>
              </XStack>
            </XStack>
          )}
        />

        {/* Timeline Chart (simplified text version) */}
        {timeline.length > 0 && (
          <YStack
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$3"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
            overflow="hidden"
          >
            <XStack
              alignItems="center"
              gap="$2"
              padding="$3"
              backgroundColor="rgba(39, 39, 42, 0.3)"
              borderBottomWidth={1}
              borderBottomColor="rgba(39, 39, 42, 0.5)"
            >
              <Calendar size={18} color="$gray11" />
              <Text fontSize="$3" fontWeight="600" color="$gray12">
                Usage Timeline
              </Text>
            </XStack>
            <YStack padding="$3" gap="$1">
              {timeline.slice(-10).map((point, index) => {
                const date = new Date(point._id);
                const maxCost = Math.max(...timeline.map((p) => p.totalCost));
                const barWidth = (point.totalCost / maxCost) * 100;

                return (
                  <XStack key={index} gap="$2" alignItems="center">
                    <Text fontSize="$1" color="$gray11" minWidth={120}>
                      {date.toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        hour12: false,
                      })}
                    </Text>
                    <XStack flex={1} alignItems="center" gap="$2">
                      <YStack
                        height={20}
                        width={`${barWidth}%`}
                        backgroundColor="$blue9"
                        borderRadius="$1"
                      />
                      <Text fontSize="$1" color="$green10" fontWeight="600">
                        {formatCost(point.totalCost)}
                      </Text>
                    </XStack>
                  </XStack>
                );
              })}
            </YStack>
          </YStack>
        )}
      </YStack>
    </ScrollView>
  );
}
