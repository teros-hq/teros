/**
 * Google Contacts MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
// Import sub-renderers
import {
  CreateContactRenderer,
  DeleteContactRenderer,
  GetContactRenderer,
  ListContactsRenderer,
  SearchContactsRenderer,
  UpdateContactRenderer,
} from './contacts/ContactsRenderer';
import { Badge, getShortToolName, HeaderRow } from './contacts/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'list-contacts': ListContactsRenderer,
  'get-contact': GetContactRenderer,
  'search-contacts': SearchContactsRenderer,
  'create-contact': CreateContactRenderer,
  'update-contact': UpdateContactRenderer,
  'delete-contact': DeleteContactRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <HeaderRow
      status={status}
      description={shortName}
      duration={duration}
      badge={badge}
      expanded={false}
      onToggle={() => {}}
    />
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function ContactsRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const ContactsToolCallRenderer = withPermissionSupport(ContactsRendererBase);
export default ContactsToolCallRenderer;
