/**
 * TokenBudgetDetails - Detailed view of token usage
 *
 * Shows two columns:
 * - Left: Session Totals (accumulated across all requests)
 * - Right: Current Context breakdown with progress bar
 */

import type { TokenBudget } from '@teros/shared';
import { formatTokenCount, TOKEN_BUDGET_COLORS } from '@teros/shared';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

interface TokenBudgetDetailsProps {
  budget: TokenBudget;
}

export function TokenBudgetDetails({ budget }: TokenBudgetDetailsProps) {
  const { modelLimit, breakdown, cost } = budget;

  // Calculate total for current context breakdown
  const currentContextTotal =
    breakdown.system +
    breakdown.tools +
    (breakdown.examples || 0) +
    (breakdown.summary || 0) +
    (breakdown.previous || 0) +
    breakdown.memory +
    (breakdown.context || 0) +
    (breakdown.latest || 0) +
    (breakdown.toolCalls || 0) +
    (breakdown.toolResults || 0) +
    (breakdown.output || 0);

  // Calculate percentages relative to currentContextTotal for display
  const getContextPercent = (value: number | undefined) =>
    currentContextTotal > 0 ? ((value || 0) / currentContextTotal) * 100 : 0;

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Summary row */}
      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>
          {formatTokenCount(currentContextTotal)} / {formatTokenCount(modelLimit)}
        </Text>
        {cost.session > 0 && <Text style={styles.summaryCost}>${cost.session.toFixed(4)}</Text>}
      </View>

      {/* Two columns */}
      <View style={styles.columnsContainer}>
        {/* Left column: Session Totals */}
        <View style={styles.column}>
          <Text style={styles.columnTitle}>Session Totals</Text>
          <Text style={styles.columnSubtitle}>Accumulated across all requests</Text>

          <View style={styles.statsContainer}>
            <StatRow label="Cache Read" value={formatTokenCount(cost.tokens.cacheRead)} />
            <StatRow label="Cache Write" value={formatTokenCount(cost.tokens.cacheWrite)} />
            <StatRow label="Regular" value={formatTokenCount(cost.tokens.input)} />
            <View style={styles.statDivider} />
            <StatRow
              label="Total Input"
              value={formatTokenCount(
                cost.tokens.input + cost.tokens.cacheRead + cost.tokens.cacheWrite,
              )}
              bold
            />
            <StatRow label="Total Output" value={formatTokenCount(cost.tokens.output)} bold />

            {cost.callCount && cost.callCount > 0 && (
              <>
                <View style={styles.statDivider} />
                <StatRow label="Requests" value={String(cost.callCount)} />
                <StatRow
                  label="Avg Input/Req"
                  value={formatTokenCount(
                    Math.round(
                      (cost.tokens.input + cost.tokens.cacheRead + cost.tokens.cacheWrite) /
                        cost.callCount,
                    ),
                  )}
                />
                <StatRow
                  label="Avg Output/Req"
                  value={formatTokenCount(Math.round(cost.tokens.output / cost.callCount))}
                />
              </>
            )}

            {cost.session > 0 && (
              <>
                <View style={styles.statDivider} />
                <StatRow label="Total Cost" value={`$${cost.session.toFixed(4)}`} bold />
              </>
            )}
          </View>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Right column: Current Context */}
        <View style={styles.column}>
          <Text style={styles.columnTitle}>Current Context</Text>
          <Text style={styles.columnSubtitle}>
            Last request ({formatTokenCount(currentContextTotal)})
          </Text>

          {/* Progress bar */}
          <View style={styles.barContainer}>
            <View style={styles.barBackground}>
              {breakdown.system > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.system)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.system,
                    },
                  ]}
                />
              )}
              {breakdown.tools > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.tools)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.tools,
                    },
                  ]}
                />
              )}
              {(breakdown.examples || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.examples)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.examples,
                    },
                  ]}
                />
              )}
              {(breakdown.summary || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.summary)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.summary,
                    },
                  ]}
                />
              )}
              {(breakdown.previous || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.previous)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.previous,
                    },
                  ]}
                />
              )}
              {breakdown.memory > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.memory)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.memory,
                    },
                  ]}
                />
              )}
              {(breakdown.context || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.context)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.context,
                    },
                  ]}
                />
              )}
              {(breakdown.latest || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.latest)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.latest,
                    },
                  ]}
                />
              )}
              {(breakdown.toolCalls || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.toolCalls)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.toolCalls,
                    },
                  ]}
                />
              )}
              {(breakdown.toolResults || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.toolResults)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.toolResults,
                    },
                  ]}
                />
              )}
              {(breakdown.output || 0) > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${getContextPercent(breakdown.output)}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.output,
                    },
                  ]}
                />
              )}
            </View>
          </View>

          {/* Breakdown list */}
          <View style={styles.breakdownList}>
            <BreakdownRow
              label="System"
              value={breakdown.system}
              percent={getContextPercent(breakdown.system)}
              color={TOKEN_BUDGET_COLORS.system}
            />
            <BreakdownRow
              label="Tools"
              value={breakdown.tools}
              percent={getContextPercent(breakdown.tools)}
              color={TOKEN_BUDGET_COLORS.tools}
            />
            <BreakdownRow
              label="Examples"
              value={breakdown.examples || 0}
              percent={getContextPercent(breakdown.examples)}
              color={TOKEN_BUDGET_COLORS.examples}
            />
            <BreakdownRow
              label="Summary"
              value={breakdown.summary || 0}
              percent={getContextPercent(breakdown.summary)}
              color={TOKEN_BUDGET_COLORS.summary}
            />
            <BreakdownRow
              label="Previous"
              value={breakdown.previous || 0}
              percent={getContextPercent(breakdown.previous)}
              color={TOKEN_BUDGET_COLORS.previous}
              cached
            />
            <View style={styles.cacheBreakpoint}>
              <Text style={styles.cacheBreakpointText}>── cache ──</Text>
            </View>
            <BreakdownRow
              label="Memory"
              value={breakdown.memory}
              percent={getContextPercent(breakdown.memory)}
              color={TOKEN_BUDGET_COLORS.memory}
            />
            <BreakdownRow
              label="Context"
              value={breakdown.context || 0}
              percent={getContextPercent(breakdown.context)}
              color={TOKEN_BUDGET_COLORS.context}
            />
            <BreakdownRow
              label="Latest"
              value={breakdown.latest || 0}
              percent={getContextPercent(breakdown.latest)}
              color={TOKEN_BUDGET_COLORS.latest}
            />
            <BreakdownRow
              label="Tool Calls"
              value={breakdown.toolCalls || 0}
              percent={getContextPercent(breakdown.toolCalls)}
              color={TOKEN_BUDGET_COLORS.toolCalls}
            />
            <BreakdownRow
              label="Tool Results"
              value={breakdown.toolResults || 0}
              percent={getContextPercent(breakdown.toolResults)}
              color={TOKEN_BUDGET_COLORS.toolResults}
            />
            <BreakdownRow
              label="Output"
              value={breakdown.output || 0}
              percent={getContextPercent(breakdown.output)}
              color={TOKEN_BUDGET_COLORS.output}
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

/** Helper component for stat rows */
function StatRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.statRow}>
      <Text style={bold ? styles.statLabelBold : styles.statLabel}>{label}</Text>
      <Text style={bold ? styles.statValueBold : styles.statValue}>{value}</Text>
    </View>
  );
}

/** Helper component for breakdown rows */
function BreakdownRow({
  label,
  value,
  percent,
  color,
  cached,
}: {
  label: string;
  value: number;
  percent: number;
  color: string;
  cached?: boolean;
}) {
  return (
    <View style={styles.breakdownRow}>
      <View style={styles.breakdownLabel}>
        <View style={[styles.breakdownDot, { backgroundColor: color }]} />
        <Text selectable style={styles.breakdownText}>
          {label}
        </Text>
        {cached && <Text style={styles.cachedBadge}>cached</Text>}
      </View>
      <Text selectable style={styles.breakdownValue}>
        {formatTokenCount(value)} ({percent.toFixed(1)}%)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 500,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  summaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e4e4e7',
  },
  summaryCost: {
    fontSize: 14,
    color: '#06B6D4',
    fontWeight: '500',
  },
  columnsContainer: {
    flexDirection: 'row',
    gap: 16,
  },
  column: {
    flex: 1,
  },
  columnTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e4e4e7',
    marginBottom: 2,
  },
  columnSubtitle: {
    fontSize: 11,
    color: '#666',
    marginBottom: 12,
  },
  divider: {
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  statsContainer: {
    gap: 6,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statLabel: {
    fontSize: 12,
    color: '#888',
  },
  statLabelBold: {
    fontSize: 12,
    color: '#e4e4e7',
    fontWeight: '600',
  },
  statValue: {
    fontSize: 12,
    color: '#ccc',
    fontFamily: 'monospace',
  },
  statValueBold: {
    fontSize: 12,
    color: '#e4e4e7',
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  statDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginVertical: 4,
  },
  barContainer: {
    marginBottom: 12,
  },
  barBackground: {
    height: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 4,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  barSegment: {
    height: '100%',
  },
  breakdownList: {
    gap: 4,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  breakdownLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  breakdownDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  breakdownText: {
    fontSize: 11,
    color: '#888',
  },
  breakdownValue: {
    fontSize: 11,
    color: '#666',
    fontFamily: 'monospace',
  },
  cachedBadge: {
    fontSize: 9,
    color: '#06B6D4',
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: 4,
  },
  cacheBreakpoint: {
    alignItems: 'center',
    marginVertical: 4,
  },
  cacheBreakpointText: {
    fontSize: 9,
    color: '#444',
  },
});
