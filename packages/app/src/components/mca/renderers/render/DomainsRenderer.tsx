/**
 * Render MCA Renderer - Custom Domains & Disks
 *
 * Handles: render-list-custom-domains, render-add-custom-domain,
 *          render-delete-custom-domain, render-verify-custom-domain,
 *          render-list-disks, render-add-disk
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
  KeyValueRow,
  parseOutput,
  type RenderDisk,
  type RenderDomain,
  truncate,
} from './shared';

// ============================================================================
// Helpers
// ============================================================================

function getDomainVerificationBadgeVariant(
  status?: string,
): 'success' | 'warning' | 'error' | 'gray' {
  if (!status) return 'gray';
  switch (status) {
    case 'verified':
      return 'success';
    case 'pending':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      return 'gray';
  }
}

// ============================================================================
// Content Blocks
// ============================================================================

function DomainRow({ domain }: { domain: RenderDomain }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const variant = getDomainVerificationBadgeVariant(domain.verificationStatus);

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      cursor="pointer"
      onPress={() => Linking.openURL(`https://${domain.name}`)}
    >
      {/* Domain name */}
      <Text flex={1} color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={1}>
        {domain.name}
      </Text>

      {/* Verification badge */}
      <Badge text={domain.verificationStatus || 'unknown'} variant={variant} />

      {/* Link icon */}
      <ExternalLink size={10} color={c.text3} />
    </XStack>
  );
}

function DiskRow({ disk }: { disk: RenderDisk }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
    >
      {/* Disk icon */}
      <Text color={colors.renderGreen} fontSize={12}>
        💾
      </Text>

      {/* Name */}
      <Text flex={1} color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>
        {disk.name}
      </Text>

      {/* Mount path */}
      {disk.mountPath && (
        <Text color={c.text2} fontSize={9} fontFamily="$mono">
          {disk.mountPath}
        </Text>
      )}

      {/* Size */}
      {disk.sizeGB !== undefined && (
        <Badge text={`${disk.sizeGB}GB`} variant="gray" />
      )}
    </XStack>
  );
}

// ============================================================================
// Domain Renderers
// ============================================================================

export function ListCustomDomainsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderDomain[]>(output) : null;
  const domains = Array.isArray(parsed) ? parsed : null;
  const isDomainArray = Array.isArray(domains) && domains.length > 0 && 'name' in domains[0];

  const description = input?.serviceId
    ? `Domains for ${truncate(input.serviceId, 20)}`
    : 'List custom domains';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDomainArray) {
    badge = <Badge text={`${domains!.length} domains`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isDomainArray && (
          <ScrollView
            style={{ maxHeight: 220, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {domains!.map((d) => (
                <DomainRow key={d.id} domain={d} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {!isDomainArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function AddCustomDomainRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; domainId?: string; name?: string; verificationStatus?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'domainId' in parsed;

  const description = input?.domain
    ? `Add domain: ${truncate(input.domain, 30)}`
    : 'Add custom domain';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="added" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; domainId?: string; name?: string; verificationStatus?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.name && <KeyValueRow label="Domain" value={result.name} mono />}
            {result.domainId && <KeyValueRow label="ID" value={result.domainId} mono />}
            {result.verificationStatus && (
              <KeyValueRow
                label="Verification"
                value={result.verificationStatus}
                valueColor={
                  result.verificationStatus === 'verified'
                    ? colors.statusLive
                    : colors.statusSuspended
                }
              />
            )}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeleteCustomDomainRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; deleted?: boolean }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed);

  const description = input?.domainId
    ? `Remove domain ${truncate(input.domainId, 20)}`
    : 'Delete custom domain';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result?.message && <SuccessBlock message={result.message} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function VerifyCustomDomainRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ domainId?: string; name?: string; verificationStatus?: string; message?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'verificationStatus' in parsed;

  const description = input?.domainId
    ? `Verify domain ${truncate(input.domainId, 20)}`
    : 'Verify custom domain';

  const result = parsed as { verificationStatus?: string; name?: string; domainId?: string; message?: string } | null;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isResult) {
    const vs = result?.verificationStatus;
    badge = (
      <Badge
        text={vs || 'unknown'}
        variant={vs === 'verified' ? 'success' : vs === 'pending' ? 'warning' : 'error'}
      />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.name && <KeyValueRow label="Domain" value={result.name} mono />}
            {result.verificationStatus && (
              <KeyValueRow
                label="Status"
                value={result.verificationStatus}
                valueColor={
                  result.verificationStatus === 'verified'
                    ? colors.statusLive
                    : result.verificationStatus === 'pending'
                      ? colors.statusSuspended
                      : colors.statusFailed
                }
              />
            )}
            {result.message && (
              <Text color={c.text2} fontSize={9} marginTop={2}>
                {result.message}
              </Text>
            )}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

// ============================================================================
// Disk Renderers
// ============================================================================

export function ListDisksRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderDisk[]>(output) : null;
  const disks = Array.isArray(parsed) ? parsed : null;
  const isDiskArray = Array.isArray(disks) && disks.length > 0 && 'mountPath' in disks[0];

  const description = input?.serviceId
    ? `Disks for ${truncate(input.serviceId, 20)}`
    : 'List disks';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDiskArray) {
    badge = <Badge text={`${disks!.length} disk${disks!.length > 1 ? 's' : ''}`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isDiskArray && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {disks!.map((d) => (
              <DiskRow key={d.id} disk={d} />
            ))}
          </YStack>
        )}
        {!isDiskArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function AddDiskRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; diskId?: string; name?: string; mountPath?: string; sizeGB?: number }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'diskId' in parsed;

  const description = input?.name
    ? `Add disk: ${truncate(input.name, 25)}`
    : 'Add disk';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="added" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; diskId?: string; name?: string; mountPath?: string; sizeGB?: number } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.name && <KeyValueRow label="Name" value={result.name} />}
            {result.diskId && <KeyValueRow label="Disk ID" value={result.diskId} mono />}
            {result.mountPath && <KeyValueRow label="Mount" value={result.mountPath} mono />}
            {result.sizeGB !== undefined && (
              <KeyValueRow label="Size" value={`${result.sizeGB} GB`} />
            )}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
