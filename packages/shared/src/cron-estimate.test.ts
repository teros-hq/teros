import { describe, expect, it } from 'bun:test'
import { countCronFieldValues, estimateCronRunsPerDay } from './cron-estimate'

describe('estimateCronRunsPerDay', () => {
  it('counts the common shapes', () => {
    expect(estimateCronRunsPerDay('* * * * *')).toBe(1440)
    expect(estimateCronRunsPerDay('*/5 * * * *')).toBe(288)
    expect(estimateCronRunsPerDay('0 * * * *')).toBe(24)
    expect(estimateCronRunsPerDay('0 9 * * 1-5')).toBe(1)
    expect(estimateCronRunsPerDay('0,30 9-17 * * *')).toBe(18)
    expect(estimateCronRunsPerDay('15 8,20 1 * *')).toBe(2)
    expect(estimateCronRunsPerDay('30/10 9 * * *')).toBe(3)
  })

  it('refuses what it does not understand instead of guessing', () => {
    expect(estimateCronRunsPerDay('0 9 * *')).toBeNull()
    expect(estimateCronRunsPerDay('x 9 * * *')).toBeNull()
    expect(estimateCronRunsPerDay('0 25 * * *')).toBeNull()
    expect(estimateCronRunsPerDay('*/0 * * * *')).toBeNull()
    expect(countCronFieldValues('10-5', 'hour')).toBeNull()
  })
})
