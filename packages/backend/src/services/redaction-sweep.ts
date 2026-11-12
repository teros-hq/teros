/**
 * Redaction Sweep — value-based redaction primitive
 * (docs/specs/20261031_agent-secret-tools.md, design A).
 *
 * Exact-match scan of a channel's recent messages across ALL surfaces where a
 * secret can live, marking every match as redacted with the SAME mechanism as
 * `channel.toggle_redaction` (reversible by the owner via un-redact).
 *
 * Surfaces scanned:
 * - channel_messages: full content (text, tool_execution input/output/error,
 *   html, captions…) + metadata — via JSON.stringify exact-substring match.
 * - session_messages (LLM context): every part — TextPart.text,
 *   ToolPart.state.input/output/error — same exact-substring match.
 *
 * The sweep is SELF-REDACTING by construction: the tool call's own message
 * (whose arguments contain the value) is a normal channel message containing
 * the value, so it is swept like any other. No special-casing.
 *
 * Security invariants:
 * - The value is NEVER logged, returned, or persisted — only message ids.
 * - Redaction rights: the caller (backend route / WS action) is responsible
 *   for authorization. The agent-facing entry points grant a NARROW exception
 *   to owner-only canRedact: redact only messages matching this value, in the
 *   calling channel, nothing else.
 * - Over-redaction is the safe direction: a whole channel message is flagged
 *   even when only one part matched (same as toggle_redaction).
 */

import type { Db } from 'mongodb';
import type { ChannelManager } from './channel-manager';
import { createLogger } from '../lib/logger';

const log = createLogger('RedactionSweep');

export const DEFAULT_SWEEP_WINDOW = 200;

export interface SweepOptions {
  /** How many recent channel messages to scan (default 200). */
  window?: number;
  /** Extra channel-message ids to redact even if the exact match missed them
   *  (split key, transformed value). */
  alsoRedact?: string[];
  /** Actor recorded as redactedBy (agent id or user id). */
  redactedBy: string;
}

export interface SweepSurfaceStats {
  text: number;
  toolInput: number;
  toolOutput: number;
  toolError: number;
  other: number;
}

export interface SweepResult {
  /** Channel messages redacted (incl. alsoRedact). */
  redactedCount: number;
  /** ids of the redacted channel messages. */
  messageIds: string[];
  /** Session-message docs flagged directly (not covered by channel propagation). */
  sessionDocsFlagged: number;
  /** How many messages matched per surface (a message can match several). */
  surfaces: SweepSurfaceStats;
  /** ids from alsoRedact that were actually found and redacted. */
  alsoRedacted: string[];
}

/** Does this channel message contain the value in ANY surface? + which ones. */
function matchChannelMessage(msg: any, value: string): SweepSurfaceStats | null {
  const surfaces: SweepSurfaceStats = { text: 0, toolInput: 0, toolOutput: 0, toolError: 0, other: 0 };
  let matched = false;

  const content = msg?.content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string' && content.text.includes(value)) {
      surfaces.text++;
      matched = true;
    }
    if (content.type === 'tool_execution') {
      if (content.input != null && JSON.stringify(content.input).includes(value)) {
        surfaces.toolInput++;
        matched = true;
      }
      if (typeof content.output === 'string' && content.output.includes(value)) {
        surfaces.toolOutput++;
        matched = true;
      }
      if (typeof content.error === 'string' && content.error.includes(value)) {
        surfaces.toolError++;
        matched = true;
      }
    } else if (JSON.stringify(content).includes(value)) {
      // html, captions, form values, any other content type
      surfaces.other++;
      matched = true;
    }
  }

  if (msg?.metadata && JSON.stringify(msg.metadata).includes(value)) {
    surfaces.other++;
    matched = true;
  }

  return matched ? surfaces : null;
}

/** Does this session-message doc contain the value in any part? */
function matchSessionDoc(doc: any, value: string): boolean {
  const parts = doc?.parts;
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (part == null) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.includes(value)) {
      return true;
    }
    if (part.type === 'tool') {
      const state = part.state ?? {};
      if (state.input != null && JSON.stringify(state.input).includes(value)) return true;
      if (typeof state.output === 'string' && state.output.includes(value)) return true;
      if (typeof state.error === 'string' && state.error.includes(value)) return true;
    }
    // Any other part type: stringify as a catch-all (reasoning, snapshots…)
    if (part.type !== 'text' && part.type !== 'tool' && JSON.stringify(part).includes(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Sweep a channel: redact every recent message (channel + session stores)
 * containing the exact value.
 *
 * Authorization is the CALLER's responsibility — this function trusts its
 * inputs (backend-internal). Agent-facing entry points:
 *   - WS action `redact_by_value` (conversations MCA) — asks permission via
 *     the tool's alwaysAsk annotation, then calls this with the acting agent.
 *   - `set-app-secret` backend route — rides on its own confirmation and
 *     calls this server-side after the credential write.
 */
export async function sweepRedactByValue(
  db: Db,
  channelManager: ChannelManager,
  channelId: string,
  value: string,
  opts: SweepOptions,
): Promise<SweepResult> {
  if (!channelId) throw new Error('channelId is required');
  if (!value || typeof value !== 'string') throw new Error('value is required');
  // Refuse to sweep trivially short values — they would redact half the
  // channel (false positives) and are never a real secret.
  if (value.length < 4) throw new Error('value too short to sweep safely (min 4 chars)');

  const window = Math.max(1, Math.min(opts.window ?? DEFAULT_SWEEP_WINDOW, 1000));
  const surfaces: SweepSurfaceStats = { text: 0, toolInput: 0, toolOutput: 0, toolError: 0, other: 0 };
  const messageIds: string[] = [];
  const alsoRedacted: string[] = [];

  const bump = (s: SweepSurfaceStats) => {
    surfaces.text += s.text;
    surfaces.toolInput += s.toolInput;
    surfaces.toolOutput += s.toolOutput;
    surfaces.toolError += s.toolError;
    surfaces.other += s.other;
  };

  // ── 1. Scan channel_messages (most recent `window`) ──────────────────────
  const channelMessages = await db
    .collection('channel_messages')
    .find({ channelId })
    .sort({ timestamp: -1 })
    .limit(window)
    .toArray();

  const matchingIds: string[] = [];
  for (const msg of channelMessages) {
    const stats = matchChannelMessage(msg, value);
    if (stats) {
      matchingIds.push(msg.messageId);
      bump(stats);
    }
  }

  // ── 2. alsoRedact: explicit ids, validated to exist in this channel ──────
  const alsoIds = new Set<string>();
  for (const id of opts.alsoRedact ?? []) {
    if (typeof id === 'string' && id) alsoIds.add(id);
  }
  if (alsoIds.size > 0) {
    const found = await db
      .collection('channel_messages')
      .find({ channelId, messageId: { $in: [...alsoIds] } })
      .project({ messageId: 1 })
      .toArray();
    for (const doc of found) alsoRedacted.push(doc.messageId);
  }

  // ── 3. Redact channel messages (toggleMessageRedaction propagates the flag
  //       to session_messages by turnId / channelMessageId — MUW-F1) ────────
  const toRedact = [...new Set([...matchingIds, ...alsoRedacted])];
  for (const messageId of toRedact) {
    const updated = await channelManager.toggleMessageRedaction(
      channelId,
      messageId,
      true,
      opts.redactedBy,
    );
    if (updated) messageIds.push(messageId);
  }

  // ── 4. Session store direct pass: parts containing the value whose docs
  //       were NOT flagged by the propagation above (e.g. a session doc with
  //       no channelMessageId linkage, or parts that carry the value while the
  //       channel bubble doesn't). Over-redaction is the safe direction. ────
  const sessionMessages = db.collection('session_messages');
  const sessionDocs = await sessionMessages
    .find({ sessionId: channelId })
    .sort({ _id: -1 })
    .limit(window * 2)
    .toArray();

  // Ids already covered: the propagation flags session docs whose
  // channelMessageId/turnId matches a redacted channel message. We can't know
  // turnIds without re-reading, so simply re-check each doc's flag after the
  // propagation ran.
  let sessionDocsFlagged = 0;
  const now = new Date().toISOString();
  for (const doc of sessionDocs) {
    if (doc?.info?.redacted === true) continue; // already covered
    if (!matchSessionDoc(doc, value)) continue;
    await sessionMessages.updateOne(
      { _id: doc._id },
      { $set: { 'info.redacted': true, 'info.redactedBy': opts.redactedBy, 'info.redactedAt': now } },
    );
    sessionDocsFlagged++;
  }

  // Coverage report — ids only, NEVER the value (AC 6).
  log.info(
    { channelId, redactedCount: messageIds.length, sessionDocsFlagged, surfaces },
    'Redaction sweep completed',
  );

  return {
    redactedCount: messageIds.length,
    messageIds,
    sessionDocsFlagged,
    surfaces,
    alsoRedacted,
  };
}
