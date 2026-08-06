/**
 * Brevo MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 100% coverage (23 tools + -health-check). The `FallbackRenderer` is a
 * dev-only signal that a sub-renderer is missing — in production it should
 * never render.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { Badge, FallbackBody, ToolCallCard, colors as globalColors } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { AddToListRenderer } from './brevo/AddToListRenderer';
import { AggregatedReportRenderer } from './brevo/AggregatedReportRenderer';
import { CreateCampaignRenderer } from './brevo/CreateCampaignRenderer';
import { CreateContactRenderer } from './brevo/CreateContactRenderer';
import { CreateListRenderer } from './brevo/CreateListRenderer';
import { CreateTemplateRenderer } from './brevo/CreateTemplateRenderer';
import { DeleteContactRenderer } from './brevo/DeleteContactRenderer';
import { EmailEventReportRenderer } from './brevo/EmailEventReportRenderer';
import { GetCampaignRenderer } from './brevo/GetCampaignRenderer';
import { GetContactRenderer } from './brevo/GetContactRenderer';
import { HealthCheckRenderer } from './brevo/HealthCheckRenderer';
import { ImportContactsRenderer } from './brevo/ImportContactsRenderer';
import { ListAttributesRenderer } from './brevo/ListAttributesRenderer';
import { ListCampaignsRenderer } from './brevo/ListCampaignsRenderer';
import { ListContactsRenderer } from './brevo/ListContactsRenderer';
import { ListFoldersRenderer } from './brevo/ListFoldersRenderer';
import { ListListsRenderer } from './brevo/ListListsRenderer';
import { ListSegmentsRenderer } from './brevo/ListSegmentsRenderer';
import { ListTemplatesRenderer } from './brevo/ListTemplatesRenderer';
import { RemoveFromListRenderer } from './brevo/RemoveFromListRenderer';
import { SendCampaignRenderer } from './brevo/SendCampaignRenderer';
import { SendEmailRenderer } from './brevo/SendEmailRenderer';
import { SendTestRenderer } from './brevo/SendTestRenderer';
import { UpdateContactRenderer } from './brevo/UpdateContactRenderer';
import { getShortToolName, getToolLabel } from './brevo/shared';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  'send-transactional-email': SendEmailRenderer,
  'list-contacts': ListContactsRenderer,
  'create-contact': CreateContactRenderer,
  'get-contact': GetContactRenderer,
  'update-contact': UpdateContactRenderer,
  'delete-contact': DeleteContactRenderer,
  'add-contact-to-list': AddToListRenderer,
  'remove-contact-from-list': RemoveFromListRenderer,
  'import-contacts': ImportContactsRenderer,
  'list-attributes': ListAttributesRenderer,
  'list-segments': ListSegmentsRenderer,
  'list-folders': ListFoldersRenderer,
  'list-lists': ListListsRenderer,
  'create-list': CreateListRenderer,
  'list-email-templates': ListTemplatesRenderer,
  'create-email-template': CreateTemplateRenderer,
  'list-email-campaigns': ListCampaignsRenderer,
  'get-email-campaign': GetCampaignRenderer,
  'create-email-campaign': CreateCampaignRenderer,
  'send-test-email': SendTestRenderer,
  'send-email-campaign': SendCampaignRenderer,
  'get-email-event-report': EmailEventReportRenderer,
  'get-aggregated-smtp-report': AggregatedReportRenderer,
};

function FallbackRenderer({ toolName, input, status, output, error, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard status={status} verb={getToolLabel(toolName)} iconUri={appIcon} badge={badge} animateExpand>
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in BrevoRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

function BrevoRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const BrevoToolCallRenderer = withPermissionSupport(BrevoRendererBase);
export default BrevoToolCallRenderer;
