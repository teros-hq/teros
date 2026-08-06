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
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, surface } from './mca/primitives/colors';

interface TokenBudgetDetailsProps {
  budget: TokenBudget;
}

export function TokenBudgetDetails({ budget }: TokenBudgetDetailsProps) {
  const { t } = useTranslation();
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
          <Text style={styles.columnTitle}>{t('conversation.sessionTotals')}</Text>
          <Text style={styles.columnSubtitle}>{t('conversation.accumulatedAcrossRequests')}</Text>

          <View style={styles.statsContainer}>
            <StatRow label={t('conversation.cacheRead')} value={formatTokenCount(cost.tokens.cacheRead)} />
            <StatRow label={t('conversation.cacheWrite')} value={formatTokenCount(cost.tokens.cacheWrite)} />
            <StatRow label={t('conversation.regular')} value={formatTokenCount(cost.tokens.input)} />
            <View style={styles.statDivider} />
            <StatRow
              label={t('conversation.totalInput')}
              value={formatTokenCount(
                cost.tokens.input + cost.tokens.cacheRead + cost.tokens.cacheWrite,
              )}
              bold
            />
            <StatRow label={t('conversation.totalOutput')} value={formatTokenCount(cost.tokens.output)} bold />

            {cost.callCount && cost.callCount > 0 && (
              <>
                <View style={styles.statDivider} />
                <StatRow label={t('conversation.requests')} value={String(cost.callCount)} />
                <StatRow
                  label={t('conversation.avgInputPerReq')}
                  value={formatTokenCount(
                    Math.round(
                      (cost.tokens.input + cost.tokens.cacheRead + cost.tokens.cacheWrite) /
                        cost.callCount,
                    ),
                  )}
                />
                <StatRow
                  label={t('conversation.avgOutputPerReq')}
                  value={formatTokenCount(Math.round(cost.tokens.output / cost.callCount))}
                />
              </>
            )}

            {cost.session > 0 && (
              <>
                <View style={styles.statDivider} />
                <StatRow label={t('conversation.totalCost')} value={`$${cost.session.toFixed(4)}`} bold />
              </>
            )}
          </View>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Right column: Current Context */}
        <View style={styles.column}>
          <Text style={styles.columnTitle}>{t('conversation.currentContext')}</Text>
          <Text style={styles.columnSubtitle}>
            {t('conversation.lastRequest', { tokens: formatTokenCount(currentContextTotal) })}
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
              label={t('conversation.system')}
              value={breakdown.system}
              percent={getContextPercent(breakdown.system)}
              color={TOKEN_BUDGET_COLORS.system}
            />
            <BreakdownRow
              label={t('conversation.tools')}
              value={breakdown.tools}
              percent={getContextPercent(breakdown.tools)}
              color={TOKEN_BUDGET_COLORS.tools}
            />
            <BreakdownRow
              label={t('conversation.examples')}
              value={breakdown.examples || 0}
              percent={getContextPercent(breakdown.examples)}
              color={TOKEN_BUDGET_COLORS.examples}
            />
            <BreakdownRow
              label={t('conversation.summary')}
              value={breakdown.summary || 0}
              percent={getContextPercent(breakdown.summary)}
              color={TOKEN_BUDGET_COLORS.summary}
            />
            <BreakdownRow
              label={t('conversation.previous')}
              value={breakdown.previous || 0}
              percent={getContextPercent(breakdown.previous)}
              color={TOKEN_BUDGET_COLORS.previous}
              cachedLabel={t('conversation.cached')}
            />
            <View style={styles.cacheBreakpoint}>
              <Text style={styles.cacheBreakpointText}>── {t('conversation.cache')} ──</Text>
            </View>
            <BreakdownRow
              label={t('conversation.memory')}
              value={breakdown.memory}
              percent={getContextPercent(breakdown.memory)}
              color={TOKEN_BUDGET_COLORS.memory}
            />
            <BreakdownRow
              label={t('conversation.context')}
              value={breakdown.context || 0}
              percent={getContextPercent(breakdown.context)}
              color={TOKEN_BUDGET_COLORS.context}
            />
            <BreakdownRow
              label={t('conversation.latest')}
              value={breakdown.latest || 0}
              percent={getContextPercent(breakdown.latest)}
              color={TOKEN_BUDGET_COLORS.latest}
            />
            <BreakdownRow
              label={t('conversation.toolCalls')}
              value={breakdown.toolCalls || 0}
              percent={getContextPercent(breakdown.toolCalls)}
              color={TOKEN_BUDGET_COLORS.toolCalls}
            />
            <BreakdownRow
              label={t('conversation.toolResults')}
              value={breakdown.toolResults || 0}
              percent={getContextPercent(breakdown.toolResults)}
              color={TOKEN_BUDGET_COLORS.toolResults}
            />
            <BreakdownRow
              label={t('conversation.output')}
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
  cachedLabel,
}: {
  label: string;
  value: number;
  percent: number;
  color: string;
  cachedLabel?: string;
}) {
  return (
    <View style={styles.breakdownRow}>
      <View style={styles.breakdownLabel}>
        <View style={[styles.breakdownDot, { backgroundColor: color }]} />
        <Text selectable style={styles.breakdownText}>
          {label}
        </Text>
        {cachedLabel && <Text style={styles.cachedBadge}>{cachedLabel}</Text>}
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
    borderBottomColor: surface.dark.border,
  },
  summaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: surface.dark.text,
  },
  summaryCost: {
    fontSize: 14,
    color: colors.indigo,
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
    color: surface.dark.text,
    marginBottom: 2,
  },
  columnSubtitle: {
    fontSize: 11,
    color: surface.dark.text3,
    marginBottom: 12,
  },
  divider: {
    width: 1,
    backgroundColor: surface.dark.border,
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
    color: surface.dark.text2,
  },
  statLabelBold: {
    fontSize: 12,
    color: surface.dark.text,
    fontWeight: '600',
  },
  statValue: {
    fontSize: 12,
    color: surface.dark.text2,
    fontFamily: 'monospace',
  },
  statValueBold: {
    fontSize: 12,
    color: surface.dark.text,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  statDivider: {
    height: 1,
    backgroundColor: surface.dark.bgInner,
    marginVertical: 4,
  },
  barContainer: {
    marginBottom: 12,
  },
  barBackground: {
    height: 8,
    backgroundColor: surface.dark.border,
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
    color: surface.dark.text2,
  },
  breakdownValue: {
    fontSize: 11,
    color: surface.dark.text3,
    fontFamily: 'monospace',
  },
  cachedBadge: {
    fontSize: 9,
    color: colors.indigo,
    backgroundColor: colors.indigoGlow,
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
    color: surface.dark.text3,
  },
});
