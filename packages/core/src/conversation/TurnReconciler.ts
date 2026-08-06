/**
 * TurnReconciler — boot-time wrapper that runs the INV-1 pipeline
 * (`assertInvariantINV1` + `synthesizeOrphans`) so a backend that crashed
 * mid-turn restarts with a valid history. Side-effect free from the
 * user's POV: the system note + resume trigger live in ResumeService.
 */

import { createLogger } from '../logger';
import { assertInvariantINV1 } from '../prompts/PromptBuilder';
import type { SessionStore } from '../session/SessionStore';
import { synthesizeOrphans } from './MessageProcessor';

const log = createLogger('TurnReconciler');

export interface ReconcileResult {
  /** Number of orphan tool_use parts that were synthesized. */
  readonly orphanedToolCount: number;
  /** True if synthesize succeeded (or there were no orphans). */
  readonly recovered: boolean;
}

/**
 * Throws if `synthesizeOrphans` exhausts its retry budget — caller
 * should mark the channel as 'requires manual intervention'.
 */
export async function reconcileChannel(
  sessionStore: SessionStore,
  channelId: string,
): Promise<ReconcileResult> {
  const { messages } = await sessionStore.getMessagesForLLM(channelId);
  const inv1 = assertInvariantINV1(messages);

  if (inv1.ok) {
    log.debug({ channelId }, 'No orphans — channel is INV-1 clean');
    return { orphanedToolCount: 0, recovered: true };
  }

  log.warn(
    { channelId, orphanedToolCount: inv1.violations.length },
    'Crash recovery: synthesizing orphan tool_results',
  );
  await synthesizeOrphans(sessionStore, channelId, inv1.violations);

  const verify = await sessionStore.getMessagesForLLM(channelId);
  const post = assertInvariantINV1(verify.messages);
  if (!post.ok) {
    log.error(
      { channelId, remainingViolations: post.violations.length },
      'Crash recovery incomplete — synthesize did not close all violations',
    );
    return { orphanedToolCount: inv1.violations.length, recovered: false };
  }

  log.info(
    { channelId, orphanedToolCount: inv1.violations.length },
    'Crash recovery completed — channel is INV-1 clean',
  );
  return { orphanedToolCount: inv1.violations.length, recovered: true };
}
