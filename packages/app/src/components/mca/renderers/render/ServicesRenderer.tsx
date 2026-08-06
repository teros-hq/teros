/**
 * Render MCA Renderer - Services
 *
 * Handles: render-list-services, render-get-service, render-create-service
 */

import { ExternalLink } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useRenderColors,
  DeployStatusBadge,
  formatDate,
  formatRelativeTime,
  getServiceStatusColor,
  isSuccessOutput,
  KeyValueRow,
  parseOutput,
  type RenderService,
  ServiceTypeBadge,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function ServiceRow({ service }: { service: RenderService }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const statusColor = getServiceStatusColor(service.status);
  const url = service.serviceDetails?.url;

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      cursor={url ? 'pointer' : 'default'}
      onPress={() => url && Linking.openURL(url)}
    >
      {/* Status dot */}
      <XStack
        width={6}
        height={6}
        borderRadius={3}
        backgroundColor={statusColor}
        flexShrink={0}
      />

      {/* Name */}
      <Text flex={1} color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>
        {service.name}
      </Text>

      {/* Type badge */}
      <ServiceTypeBadge type={service.type} />

      {/* Status badge */}
      <DeployStatusBadge status={service.status} />

      {/* External link */}
      {url && <ExternalLink size={10} color={c.text3} />}
    </XStack>
  );
}

function ServiceDetailBlock({ service }: { service: RenderService }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const d = service.serviceDetails;
  const url = d?.url;

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      {/* Header */}
      <XStack alignItems="center" gap={8}>
        <Text flex={1} color={c.text} fontSize={11} fontWeight="600" numberOfLines={1}>
          {service.name}
        </Text>
        <ServiceTypeBadge type={service.type} />
        <DeployStatusBadge status={service.status} />
        {url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(url)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={c.text2} />
          </XStack>
        )}
      </XStack>

      {/* Details */}
      <YStack gap={3}>
        <KeyValueRow label="ID" value={service.id} mono />
        {d?.region && <KeyValueRow label="Region" value={d.region} />}
        {d?.plan && <KeyValueRow label="Plan" value={d.plan} />}
        {d?.repoURL && <KeyValueRow label="Repo" value={d.repoURL} />}
        {d?.branch && <KeyValueRow label="Branch" value={d.branch} mono />}
        {d?.buildCommand && <KeyValueRow label="Build" value={d.buildCommand} mono />}
        {d?.startCommand && <KeyValueRow label="Start" value={d.startCommand} mono />}
        {d?.autoDeploy && (
          <KeyValueRow
            label="Auto Deploy"
            value={d.autoDeploy}
            valueColor={d.autoDeploy === 'yes' ? colors.renderGreen : c.text2}
          />
        )}
        {service.createdAt && (
          <KeyValueRow label="Created" value={formatDate(service.createdAt)} />
        )}
        {url && (
          <XStack
            gap={8}
            alignItems="center"
            marginTop={2}
            cursor="pointer"
            onPress={() => Linking.openURL(url)}
          >
            <Text color={c.text3} fontSize={9} width={70} flexShrink={0}>
              URL
            </Text>
            <Text color={colors.renderGreen} fontSize={9} fontFamily="$mono" flex={1} numberOfLines={1}>
              {url}
            </Text>
          </XStack>
        )}
      </YStack>
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListServicesRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  // Output is a markdown string like "Found N service(s):\n\n..."
  // Try to parse as JSON first, fallback to string
  const parsed = output ? parseOutput<RenderService[] | { services?: RenderService[] }>(output) : null;

  const services = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'services' in parsed
      ? (parsed as { services: RenderService[] }).services
      : null;

  const isServiceArray = Array.isArray(services) && services.length > 0;

  let description = 'List services';
  if (input?.type) description += ` [${input.type}]`;
  if (input?.name) description += `: ${input.name}`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isServiceArray) {
    badge = <Badge text={`${services!.length} services`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isServiceArray && (
          <ScrollView
            style={{ maxHeight: 280, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {services!.map((svc) => (
                <ServiceRow key={svc.id} service={svc} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {!isServiceArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetServiceRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderService>(output) : null;
  const isService =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in parsed && 'name' in parsed;

  const description = input?.serviceId
    ? `Get service ${truncate(input.serviceId, 20)}`
    : 'Get service';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isService) {
    badge = <Badge text={(parsed as RenderService).type ? (parsed as RenderService).type! : 'service'} variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isService && <ServiceDetailBlock service={parsed as RenderService} />}
        {!isService && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateServiceRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; serviceId?: string; name?: string; type?: string; status?: string; deployId?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'serviceId' in parsed;
  const isSuccess = isSuccessOutput(parsed);

  const description = input?.name
    ? `Create service: ${truncate(input.name, 30)}`
    : 'Create service';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; serviceId?: string; name?: string; type?: string; status?: string; deployId?: string; note?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.name && <KeyValueRow label="Name" value={result.name} />}
            {result.serviceId && <KeyValueRow label="Service ID" value={result.serviceId} mono />}
            {result.type && <KeyValueRow label="Type" value={result.type} />}
            {result.status && <KeyValueRow label="Status" value={result.status} />}
            {result.deployId && <KeyValueRow label="Deploy ID" value={result.deployId} mono />}
            {result.note && (
              <Text color={c.text2} fontSize={9} marginTop={2}>
                {result.note}
              </Text>
            )}
          </YStack>
        )}
        {!isResult && isSuccess && typeof parsed === 'object' && (parsed as { message?: string }).message && (
          <SuccessBlock message={(parsed as { message: string }).message} />
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
