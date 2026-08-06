/**
 * Unit tests for the one-time core-apps backfill runner (TER-385).
 *
 * Covers the marker / retry semantics the adversarial review asked for:
 * skip when already done, mark complete on a clean run, and DEFER (do not mark)
 * when any agent failed so the next boot retries.
 */
import { describe, expect, it } from 'bun:test';
import {
  type CoreAppsBackfillResult,
  runCoreAppsBackfillOnce,
} from '../../../packages/backend/src/bootstrap/core-apps-backfill';

const MARKER = 'agent-core-apps-test';

function makeCol(markerPresent: boolean) {
  const calls = { findOne: 0, updateOne: 0 };
  const col: any = {
    findOne: async () => {
      calls.findOne++;
      return markerPresent ? { name: MARKER, completedAt: new Date() } : null;
    },
    updateOne: async () => {
      calls.updateOne++;
    },
  };
  return { col, calls };
}

function makeProvisioning(result: CoreAppsBackfillResult) {
  const calls = { backfill: 0 };
  return {
    calls,
    provisioning: {
      backfillCoreApps: async () => {
        calls.backfill++;
        return result;
      },
    },
  };
}

describe('runCoreAppsBackfillOnce', () => {
  it('skips when the marker already exists (no work, no write)', async () => {
    const { col, calls } = makeCol(true);
    const { provisioning, calls: p } = makeProvisioning({
      processed: 0,
      provisioned: 0,
      skipped: 0,
      failed: 0,
    });
    const outcome = await runCoreAppsBackfillOnce(col, provisioning, MARKER);
    expect(outcome).toBe('skipped');
    expect(p.backfill).toBe(0);
    expect(calls.updateOne).toBe(0);
  });

  it('marks complete and writes the marker on a fully-clean run', async () => {
    const { col, calls } = makeCol(false);
    const { provisioning, calls: p } = makeProvisioning({
      processed: 5,
      provisioned: 4,
      skipped: 1,
      failed: 0,
    });
    const outcome = await runCoreAppsBackfillOnce(col, provisioning, MARKER);
    expect(outcome).toBe('completed');
    expect(p.backfill).toBe(1);
    expect(calls.updateOne).toBe(1);
  });

  it('defers (does NOT write the marker) when any agent failed → retries next boot', async () => {
    const { col, calls } = makeCol(false);
    const { provisioning, calls: p } = makeProvisioning({
      processed: 5,
      provisioned: 3,
      skipped: 0,
      failed: 2,
    });
    const outcome = await runCoreAppsBackfillOnce(col, provisioning, MARKER);
    expect(outcome).toBe('deferred');
    expect(p.backfill).toBe(1);
    expect(calls.updateOne).toBe(0); // marker NOT written
  });
});
