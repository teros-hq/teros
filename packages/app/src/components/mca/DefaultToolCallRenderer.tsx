/**
 * Default Tool Call Renderer — Fallback Body for MCAs without a custom
 * renderer (Renderer UX Guide v2 §0).
 *
 * Before v2 this file pinned the chat with a JSON-crud view and emitted
 * a Sentry "missing renderer" warning. v2 reframes the absence: a
 * Fallback Body is now legitimate UI. We still emit a low-noise Sentry
 * tag (`type=no_custom_renderer`) so coverage can be tracked, but the
 * tool call is fully presentable on its own.
 *
 * The renderer composes the same primitives every custom renderer uses:
 *   <ToolCallCard description="…">
 *     <FallbackBody status input output error />
 *   </ToolCallCard>
 *
 * Permission flow (`pending_permission`) keeps the existing widget for
 * now; Fase 4 of the v2 refactor swaps it for a single-line ControlsBar
 * primitive.
 */

import { FallbackBody, getShortToolName, ToolCallCard, tenseByStatus } from './primitives';
import { humanizeLabel } from './primitives/utils';
import type { ToolCallRendererProps } from './types';
import { withPermissionSupport } from './withPermissionSupport';

function DefaultToolCallRendererBase(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, appIcon, attachments } = props;

  const shortName = getShortToolName(toolName);
  const human = humanizeLabel(shortName);

  // Generic tense forms for an unknown tool. The shortName is already a
  // verb-noun phrase 90% of the time (`list-events`, `create-issue`,
  // `delete-file`), so we treat it as the bare future form.
  const future = human.toLowerCase();
  const description = tenseByStatus(status, {
    future,
    present: capitalize(toGerundish(future)),
    past: capitalize(toPastish(future)),
  });

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      animateExpand
    >
      <FallbackBody status={status} input={input} output={output} error={error} attachments={attachments} />
    </ToolCallCard>
  );
}

// withPermissionSupport injects the ControlsBar via context when status is
// pending_permission — the FallbackBody renders inside ToolCallCard, the
// HOC takes care of the rest. No more bespoke widget wiring here.
export const DefaultToolCallRenderer = withPermissionSupport(DefaultToolCallRendererBase);

// ─── small string helpers ──────────────────────────────────────────────────
//
// We don't conjugate English. We just nudge the bare phrase into a passable
// gerund / past form so the description doesn't read "Listed list events".
// If a renderer cares about correct verb forms it should register a custom
// description — this is the fallback after all.

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function toGerundish(phrase: string): string {
  // first token is the verb-ish; everything after is the object phrase
  const [first, ...rest] = phrase.split(' ');
  if (!first) return phrase;
  let verb = first;
  if (verb.endsWith('e') && !verb.endsWith('ee')) verb = `${verb.slice(0, -1)}ing`;
  else verb = `${verb}ing`;
  return [verb, ...rest].join(' ');
}

function toPastish(phrase: string): string {
  const [first, ...rest] = phrase.split(' ');
  if (!first) return phrase;
  let verb = first;
  if (verb.endsWith('e')) verb = `${verb}d`;
  else if (verb.endsWith('y')) verb = `${verb.slice(0, -1)}ied`;
  else verb = `${verb}ed`;
  return [verb, ...rest].join(' ');
}
