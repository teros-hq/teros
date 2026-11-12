/**
 * QuotaStrip — "X of Y runs today" at the top of the Automate list.
 *
 * Keeps the daily budget in sight before anything goes wrong: a thin bar
 * that turns amber past 80% and red (with an upgrade CTA and the busiest
 * automation) once the budget is spent. Unlimited plans show nothing.
 */

import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { formatResetTime } from '../../components/billing/automateQuotaCopy'
import { useColors } from '../../components/mca/primitives/useColors'
import { Btn, Ph, T } from '../../components/ui/ds'
import type { AutomateQuota } from './types/automate'

export interface QuotaStripProps {
  quota: AutomateQuota | null
  onUpgrade: () => void
  onOpenStarter?: (starterId: string) => void
}

export function QuotaStrip({ quota, onUpgrade, onOpenStarter }: QuotaStripProps) {
  const { t } = useTranslation()
  const c = useColors()
  if (!quota || quota.limit <= 0) return null

  const pct = Math.min(1, quota.used / quota.limit)
  const exhausted = quota.exhausted
  const tint = exhausted ? c.tint.r : pct >= 0.8 ? c.tint.a : null
  const resetTime = formatResetTime(quota.resetsAt) ?? '00:00 UTC'
  const busiest = quota.topStarters[0]

  return (
    <View
      testID="automate-quota-strip"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        paddingHorizontal: 14,
        marginBottom: 12,
        borderRadius: 10,
        backgroundColor: tint ? tint.bg : c.bgCard,
        borderWidth: 1,
        borderColor: tint ? tint.bd : c.border,
      }}
    >
      <Ph name="lightning" size={16} color={tint ? tint.tx : c.text2} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <T step="sm" testID="automate-quota-strip-usage">
          {exhausted
            ? t('automate.quota.exhausted', { limit: quota.limit, plan: quota.planName, time: resetTime })
            : t('automate.quota.usage', { used: quota.used, limit: quota.limit, plan: quota.planName, time: resetTime })}
        </T>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.border, overflow: 'hidden' }}>
          <View style={{ width: `${Math.round(pct * 100)}%`, height: 4, backgroundColor: tint ? tint.tx : c.text3 }} />
        </View>
        {exhausted && busiest ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <T step="12" tone="text2" testID="automate-quota-strip-busiest">
              {t('automate.quota.busiest', { name: busiest.name, count: busiest.count })}
            </T>
            {onOpenStarter ? (
              <T step="12" tone="text" testID="automate-quota-strip-review" onPress={() => onOpenStarter(busiest.starterId)}>
                {t('automate.quota.review')}
              </T>
            ) : null}
          </View>
        ) : null}
      </View>
      {exhausted || pct >= 0.8 ? (
        <Btn testID="automate-quota-strip-upgrade" size="sm" variant={exhausted ? 'primary' : 'amber'} icon="arrow-up" onPress={onUpgrade}>
          {t('automate.quota.upgrade')}
        </Btn>
      ) : null}
    </View>
  )
}
