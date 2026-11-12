/**
 * Google Contacts MCA - Custom Tool Call Renderer
 *
 * Dispatch entry point. Keys are the REAL bare tool names of
 * `mcas/mca.google.contacts/tools.json` (renamed ~1 oct 2026: the `contacts-`
 * prefix was dropped, `contacts-list-contacts` → `list-contacts`). Tools arrive
 * at runtime as `<appName>_<tool>` (e.g. `contacts_list-contacts`), so the
 * lookup goes through `getShortToolName` (last `_` segment) — same derivation
 * as the FilesystemRenderer.
 *
 * `CONTACTS_RENDERERS` is exported so the render test can pin the map ↔
 * tools.json correspondence in BOTH directions: a tool without an entry
 * silently falls to the fallback (the original bug), and a stale key after a
 * rename is dead code that the coverage test would never exercise.
 *
 * Fallback exists as a dev-only signal of a missing dispatch entry.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { Badge, FallbackBody, ToolCallCard } from '../primitives';
// Contact tools
import {
  CreateContactRenderer,
  DeleteContactRenderer,
  GetContactRenderer,
  ListContactsRenderer,
  SearchContactsRenderer,
  UpdateContactRenderer,
} from './contacts/ContactsRenderer';
// Contact group tools + health check
import {
  AddContactsToGroupRenderer,
  CreateContactGroupRenderer,
  DeleteContactGroupRenderer,
  GetContactGroupRenderer,
  ListContactGroupsRenderer,
  RemoveContactsFromGroupRenderer,
  UpdateContactGroupRenderer,
} from './contacts/ContactGroupsRenderer';
import { HealthCheckRenderer } from './contacts/HealthCheckRenderer';
import { getShortToolName } from './contacts/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

/**
 * One entry per tool in `mcas/mca.google.contacts/tools.json` (14 tools).
 * The render test (contacts/ContactsRenderer.render.test.tsx) fails CI if a
 * tools.json tool has no entry here, or if a key stops matching tools.json.
 */
export const CONTACTS_RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'list-contacts': ListContactsRenderer,
  'get-contact': GetContactRenderer,
  'search-contacts': SearchContactsRenderer,
  'create-contact': CreateContactRenderer,
  'update-contact': UpdateContactRenderer,
  'delete-contact': DeleteContactRenderer,
  'list-contact-groups': ListContactGroupsRenderer,
  'get-contact-group': GetContactGroupRenderer,
  'create-contact-group': CreateContactGroupRenderer,
  'update-contact-group': UpdateContactGroupRenderer,
  'delete-contact-group': DeleteContactGroupRenderer,
  'add-contacts-to-group': AddContactsToGroupRenderer,
  'remove-contacts-from-group': RemoveContactsFromGroupRenderer,
  '-health-check': HealthCheckRenderer,
};

// ============================================================================
// Fallback Renderer — Renderer UX Guide v2 §0
// ============================================================================

function FallbackRenderer({ toolName, status, input, output, error, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);
  console.warn(
    `[ContactsRenderer] No dedicated renderer for tool "${shortName}" — fallback indicates a bug`,
  );
  return (
    <ToolCallCard
      status={status}
      description={shortName}
      iconUri={appIcon}
      badge={<Badge text="no renderer" variant="warning" />}
    >
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function ContactsRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = CONTACTS_RENDERERS[shortName] ?? FallbackRenderer;

  return <Renderer {...props} />;
}

export const ContactsToolCallRenderer = withPermissionSupport(ContactsRendererBase);
export default ContactsToolCallRenderer;
