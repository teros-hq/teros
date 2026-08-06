/**
 * Quota-burn derivations for Agent Activity — pure, testable functions lifted
 * from the legacy God-component (git 5dc70875~1) so the Quota panel can reuse
 * them without dragging a React hook. Calendar-month window, per-user
 * projection against the REAL plan limit (TER-628), never a hardcoded 100.
 *
 * `now` is injected (defaults to a live clock) so tests are deterministic.
 */

import type { AgentUsageBucket } from '../../services/AdminApi'

/** Fallback quota (agent-hours) when a user has no metered sub / unmetered. */
export const DEFAULT_AGENT_HOURS_QUOTA = 100

export interface UserQuotaSnapshot {
  userId: string
  userName: string
  consumedHours: number
  quotaHours: number
  /** consumed / quota × 100 (can exceed 100 for over-quota users). */
  pctConsumed: number
  projectedHours: number
  daysIntoPeriod: number
  daysLeft: number
}

export interface QuotaSnapshot {
  periodStart: Date
  periodEnd: Date
  daysInPeriod: number
  daysIntoPeriod: number
  daysLeft: number
  userSnapshots: UserQuotaSnapshot[]
  perDayGlobal: number[]
  totalConsumed: number
  totalQuota: number
  totalProjected: number
  dailyConsumedByUser: Map<string, number[]>
}

/** The slice of the filter directory the quota math needs. */
export interface QuotaDirectory {
  userIdToName: Map<string, string>
  userIdToLimit: Map<string, number>
}

/**
 * Aggregate per-user agent-hours over the current calendar month and project
 * end-of-month consumption at the current average daily rate.
 *
 * Buckets outside the month window are ignored; a bucket with no `groupKey.userId`
 * folds into `(unknown)`. A user's quota is their real `agentHoursLimit`
 * (`userIdToLimit`); `0` (unmetered / no active sub) falls back to
 * `DEFAULT_AGENT_HOURS_QUOTA` so the burndown still renders.
 */
export function quotaSnapshot(
  quotaBuckets: AgentUsageBucket[],
  directory: QuotaDirectory,
  now: Date = new Date(),
): QuotaSnapshot {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const periodStart = new Date(Date.UTC(year, month, 1))
  const periodEnd = new Date(Date.UTC(year, month + 1, 1))
  const daysInPeriod = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86_400_000)
  const elapsed = now.getTime() - periodStart.getTime()
  const daysIntoPeriod = Math.max(1, Math.min(daysInPeriod, Math.ceil(elapsed / 86_400_000)))
  const daysLeft = Math.max(0, daysInPeriod - daysIntoPeriod)

  const perUser = new Map<string, number>()
  const perDayGlobal: number[] = new Array(daysInPeriod).fill(0)
  const dailyConsumedByUser = new Map<string, number[]>()
  for (const b of quotaBuckets) {
    const t = new Date(b.bucket).getTime()
    const dayIdx = Math.floor((t - periodStart.getTime()) / 86_400_000)
    if (dayIdx < 0 || dayIdx >= daysInPeriod) continue
    const uid = b.groupKey?.userId ?? '(unknown)'
    const hours = b.activeHours ?? 0
    perUser.set(uid, (perUser.get(uid) ?? 0) + hours)
    perDayGlobal[dayIdx] += hours
    let perUserArr = dailyConsumedByUser.get(uid)
    if (!perUserArr) {
      perUserArr = new Array(daysInPeriod).fill(0)
      dailyConsumedByUser.set(uid, perUserArr)
    }
    perUserArr[dayIdx] += hours
  }

  const userSnapshots: UserQuotaSnapshot[] = []
  for (const [uid, consumed] of perUser) {
    const avgDaily = daysIntoPeriod > 0 ? consumed / daysIntoPeriod : 0
    const projected = avgDaily * daysInPeriod
    const userLimit = directory.userIdToLimit.get(uid) ?? 0
    const quota = userLimit > 0 ? userLimit : DEFAULT_AGENT_HOURS_QUOTA
    userSnapshots.push({
      userId: uid,
      userName: directory.userIdToName.get(uid) ?? uid,
      consumedHours: consumed,
      quotaHours: quota,
      pctConsumed: (consumed / quota) * 100,
      projectedHours: projected,
      daysIntoPeriod,
      daysLeft,
    })
  }
  userSnapshots.sort((a, b) => b.pctConsumed - a.pctConsumed)

  const totalConsumed = userSnapshots.reduce((acc, s) => acc + s.consumedHours, 0)
  const totalQuota =
    userSnapshots.reduce((acc, s) => acc + s.quotaHours, 0) || DEFAULT_AGENT_HOURS_QUOTA
  const totalProjected = (totalConsumed / Math.max(daysIntoPeriod, 1)) * daysInPeriod

  return {
    periodStart,
    periodEnd,
    daysInPeriod,
    daysIntoPeriod,
    daysLeft,
    userSnapshots,
    perDayGlobal,
    totalConsumed,
    totalQuota,
    totalProjected,
    dailyConsumedByUser,
  }
}
