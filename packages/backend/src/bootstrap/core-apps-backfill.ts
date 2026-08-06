/**
 * One-time core-apps backfill runner (TER-385).
 *
 * Extracted from server-bootstrap so the marker / retry semantics are unit-
 * testable. The backfill provisions each existing agent's core default apps via
 * the same path as agent creation (see AgentProvisioningService.backfillCoreApps).
 */
import type { Collection } from 'mongodb';

export interface CoreAppsBackfillResult {
  processed: number;
  provisioned: number;
  skipped: number;
  failed: number;
}

export interface BackfillProvisioning {
  backfillCoreApps(): Promise<CoreAppsBackfillResult>;
}

export interface BackfillMarker {
  name: string;
  completedAt: Date;
  result?: unknown;
}

export type BackfillOutcome = 'skipped' | 'completed' | 'deferred';

/**
 * Run the backfill at most once, guarded by a marker document.
 *
 * - 'skipped'  — marker already present; nothing run.
 * - 'completed'— ran with zero per-agent failures; marker written.
 * - 'deferred' — ran but some agents failed; marker deliberately NOT written so
 *                the next boot retries. A partial run is never frozen as "done".
 */
export async function runCoreAppsBackfillOnce(
  backfillsCol: Collection<BackfillMarker>,
  provisioning: BackfillProvisioning,
  markerName: string,
): Promise<BackfillOutcome> {
  if (await backfillsCol.findOne({ name: markerName })) {
    return 'skipped';
  }

  const result = await provisioning.backfillCoreApps();

  if (result.failed === 0) {
    await backfillsCol.updateOne(
      { name: markerName },
      { $set: { name: markerName, completedAt: new Date(), result } },
      { upsert: true },
    );
    console.log(`✅ Backfill agent-core-apps complete: ${JSON.stringify(result)}`);
    return 'completed';
  }

  console.error(
    `❌ Backfill agent-core-apps had ${result.failed} failure(s) — NOT marking complete, ` +
      `will retry next boot. Summary: ${JSON.stringify(result)}`,
  );
  return 'deferred';
}
