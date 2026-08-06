import type { TokenBudget } from '@teros/shared';
import { formatTokenCount, TOKEN_BUDGET_COLORS, TOKEN_BUDGET_ORDER } from '@teros/shared';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LayoutRectangle,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, surface } from './mca/primitives/colors';

interface TokenBudgetBarProps {
  budget: TokenBudget | null;
}

/**
 * Token Budget Bar - Visual representation of context window usage
 *
 * Shows a compact bar with total usage.
 * Click to expand a popover with two columns:
 * - Left: Session Totals (accumulated across all requests)
 * - Right: Current Context breakdown with progress bar
 *
 * Schema order (optimized for cache):
 * 1. System (cached)
 * 2. Tools (cached)
 * 3. Examples (cached)
 * 4. Summary (cached)
 * 5. Previous (cached)
 * --- cache breakpoint ---
 * 6. Memory (dynamic)
 * 7. Context (dynamic)
 * 8. Latest (dynamic)
 * 9. Output (dynamic)
 */
export function TokenBudgetBar({ budget }: TokenBudgetBarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [buttonLayout, setButtonLayout] = useState<LayoutRectangle | null>(null);
  const buttonRef = useRef<View>(null);

  const handlePress = useCallback(() => {
    if (buttonRef.current) {
      buttonRef.current.measureInWindow((x, y, width, height) => {
        setButtonLayout({ x, y, width, height });
        setExpanded(true);
      });
    }
  }, []);

  if (!budget) {
    return null;
  }

  const { modelLimit, breakdown, cost } = budget;

  // Helper to calculate percent of model limit
  const pct = (value: number | undefined) =>
    modelLimit > 0 ? ((value || 0) / modelLimit) * 100 : 0;

  // Calculate percentages for each category (relative to modelLimit for the bar)
  const systemPercent = pct(breakdown.system);
  const toolsPercent = pct(breakdown.tools);
  const examplesPercent = pct(breakdown.examples);
  const summaryPercent = pct(breakdown.summary);
  const previousPercent = pct(breakdown.previous);
  const memoryPercent = pct(breakdown.memory);
  const contextPercent = pct(breakdown.context);
  const latestPercent = pct(breakdown.latest);
  const toolCallsPercent = pct(breakdown.toolCalls);
  const toolResultsPercent = pct(breakdown.toolResults);
  const outputPercent = pct(breakdown.output);

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
    <>
      {/* Compact bar only - click to toggle popover */}
      <View ref={buttonRef} collapsable={false}>
        <TouchableOpacity style={styles.container} onPress={handlePress} activeOpacity={0.7}>
          {/* Mini progress bar - follows TOKEN_BUDGET_ORDER */}
          <View style={styles.barContainer}>
            <View style={styles.barBackground}>
              {systemPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${systemPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.system },
                  ]}
                />
              )}
              {toolsPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${toolsPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.tools },
                  ]}
                />
              )}
              {examplesPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${examplesPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.examples },
                  ]}
                />
              )}
              {summaryPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${summaryPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.summary },
                  ]}
                />
              )}
              {previousPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${previousPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.previous },
                  ]}
                />
              )}
              {memoryPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${memoryPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.memory },
                  ]}
                />
              )}
              {contextPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${contextPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.context },
                  ]}
                />
              )}
              {latestPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${latestPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.latest },
                  ]}
                />
              )}
              {toolCallsPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${toolCallsPercent}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.toolCalls,
                    },
                  ]}
                />
              )}
              {toolResultsPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    {
                      width: `${toolResultsPercent}%`,
                      backgroundColor: TOKEN_BUDGET_COLORS.toolResults,
                    },
                  ]}
                />
              )}
              {outputPercent > 0 && (
                <View
                  style={[
                    styles.barSegment,
                    { width: `${outputPercent}%`, backgroundColor: TOKEN_BUDGET_COLORS.output },
                  ]}
                />
              )}
            </View>
          </View>
        </TouchableOpacity>
      </View>

      {/* Modal popover */}
      <Modal
        visible={expanded}
        transparent
        animationType="fade"
        onRequestClose={() => setExpanded(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setExpanded(false)}>
          <Pressable
            style={[
              styles.popoverContent,
              buttonLayout && {
                position: 'absolute',
                top: buttonLayout.y + buttonLayout.height + 4,
                // Center the popover relative to the bar
                left: Math.max(16, buttonLayout.x + buttonLayout.width / 2 - 250),
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            {/* Summary row */}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryText}>
                {formatTokenCount(currentContextTotal)} / {formatTokenCount(modelLimit)}
              </Text>
              {cost.session > 0 && (
                <Text style={styles.summaryCost}>${cost.session.toFixed(4)}</Text>
              )}
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
                      <StatRow label={t('conversation.totalCost')} value={`${cost.session.toFixed(4)}`} bold />
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
                <View style={styles.popoverBarContainer}>
                  <View style={styles.popoverBarBackground}>
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

                {/* Breakdown list - follows TOKEN_BUDGET_ORDER */}
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
                    cached
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
          </Pressable>
        </Pressable>
      </Modal>
    </>
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
  const { t } = useTranslation();
  return (
    <View style={styles.breakdownRow}>
      <View style={styles.breakdownLabel}>
        <View style={[styles.breakdownDot, { backgroundColor: color }]} />
        <Text selectable style={styles.breakdownText}>
          {label}
        </Text>
        {cached && <Text style={styles.cachedBadge}>{t('conversation.cached')}</Text>}
      </View>
      <Text selectable style={styles.breakdownValue}>
        {formatTokenCount(value)} ({percent.toFixed(1)}%)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Compact bar styles
  container: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  barContainer: {
    height: 6,
  },
  barBackground: {
    flex: 1,
    backgroundColor: TOKEN_BUDGET_COLORS.available,
    borderRadius: 3,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  barSegment: {
    height: '100%',
  },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: surface.dark.bgInner,
  },
  popoverContent: {
    backgroundColor: surface.dark.bgCard,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: surface.dark.borderStrong,
    minWidth: 500,
    maxWidth: 600,
    ...Platform.select({
      web: {
        boxShadow: surface.dark.shadow,
      },
      default: {
        shadowColor: surface.dark.bgPage,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 25,
        elevation: 15,
      },
    }),
  },

  // Summary row in popover
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: surface.dark.border,
  },
  summaryText: {
    color: surface.dark.text,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  summaryCost: {
    color: colors.indigo,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Columns
  columnsContainer: {
    flexDirection: 'row',
  },
  column: {
    flex: 1,
  },
  divider: {
    width: 1,
    backgroundColor: surface.dark.border,
    marginHorizontal: 12,
  },
  columnTitle: {
    color: surface.dark.text,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  columnSubtitle: {
    color: surface.dark.text3,
    fontSize: 9,
    marginBottom: 8,
  },

  // Stats (left column)
  statsContainer: {
    gap: 4,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statDivider: {
    height: 1,
    backgroundColor: surface.dark.bgInner,
    marginVertical: 4,
  },
  statLabel: {
    color: surface.dark.text2,
    fontSize: 10,
  },
  statValue: {
    color: surface.dark.text2,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  statLabelBold: {
    color: surface.dark.text,
    fontSize: 10,
    fontWeight: '600',
  },
  statValueBold: {
    color: surface.dark.text,
    fontSize: 10,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Progress bar in popover
  popoverBarContainer: {
    height: 8,
    marginBottom: 8,
  },
  popoverBarBackground: {
    flex: 1,
    backgroundColor: TOKEN_BUDGET_COLORS.available,
    borderRadius: 4,
    flexDirection: 'row',
    overflow: 'hidden',
  },

  // Breakdown list (right column)
  breakdownList: {
    gap: 3,
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
    color: surface.dark.text2,
    fontSize: 10,
  },
  breakdownValue: {
    color: surface.dark.text3,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  cachedBadge: {
    color: colors.green,
    fontSize: 8,
    marginLeft: 4,
    opacity: 0.7,
  },
  cacheBreakpoint: {
    marginVertical: 2,
  },
  cacheBreakpointText: {
    color: colors.red,
    fontSize: 8,
    textAlign: 'center',
    opacity: 0.5,
  },
});
