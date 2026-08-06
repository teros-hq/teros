/**
 * Render MCA Renderer - Deployments
 *
 * Handles: render-list-deploys, render-get-deploy, render-trigger-deploy,
 *          render-cancel-deploy, render-rollback-deploy
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRenderColors,
  DeployStatusBadge,
  formatRelativeTime,
  getDeployStatusColor,
  isSuccessOutput,
  KeyValueRow,
  parseOutput,
  type RenderDeploy,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function DeployRow({ deploy, highlight = false }: { deploy: RenderDeploy; highlight?: boolean }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const commitMsg = deploy.commit?.message
    ? truncate(deploy.commit.message, 50)
    : null;

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      backgroundColor={highlight ? 'rgba(70,227,183,0.06)' : 'transparent'}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
    >
      {/* Deploy ID (short) */}
      <Text color={colors.renderGreen} fontSize={9} fontFamily="$mono" width={60} numberOfLines={1}>
        {deploy.id.slice(0, 8)}
      </Text>

      {/* Commit message or empty */}
      <Text flex={1} color={c.text2} fontSize={9} numberOfLines={1}>
        {commitMsg || deploy.trigger || '—'}
      </Text>

      {/* Time */}
      <Text color={c.text3} fontSize={9} fontFamily="$mono">
        {formatRelativeTime(deploy.createdAt)}
      </Text>

      {/* Status */}
      <DeployStatusBadge status={deploy.status} />
    </XStack>
  );
}

function DeployDetailBlock({ deploy }: { deploy: RenderDeploy }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const statusColor = getDeployStatusColor(deploy.status);

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
        <Text color={colors.renderGreen} fontSize={10} fontFamily="$mono" fontWeight="600">
          {deploy.id.slice(0, 12)}…
        </Text>
        <DeployStatusBadge status={deploy.status} />
      </XStack>

      {/* Details */}
      <YStack gap={3}>
        <KeyValueRow label="Full ID" value={deploy.id} mono />
        {deploy.trigger && <KeyValueRow label="Trigger" value={deploy.trigger} />}
        {deploy.commit?.message && (
          <KeyValueRow label="Commit" value={truncate(deploy.commit.message, 60)} />
        )}
        {deploy.commit?.id && (
          <KeyValueRow label="SHA" value={deploy.commit.id.slice(0, 8)} mono />
        )}
        {deploy.createdAt && (
          <KeyValueRow label="Started" value={formatRelativeTime(deploy.createdAt)} />
        )}
        {deploy.finishedAt && (
          <KeyValueRow label="Finished" value={formatRelativeTime(deploy.finishedAt)} />
        )}
      </YStack>
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListDeploysRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderDeploy[] | string>(output) : null;
  const deploys = Array.isArray(parsed) ? parsed : null;
  const isDeployArray = Array.isArray(deploys) && deploys.length > 0;

  const description = input?.serviceId
    ? `Deploys for ${truncate(input.serviceId, 20)}`
    : 'List deploys';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDeployArray) {
    badge = <Badge text={`${deploys!.length} deploys`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isDeployArray && (
          <ScrollView
            style={{ maxHeight: 260, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {deploys!.map((d) => (
                <DeployRow key={d.id} deploy={d} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {!isDeployArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetDeployRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderDeploy>(output) : null;
  const isDeploy =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in parsed && 'status' in parsed;

  const description = input?.deployId
    ? `Deploy ${truncate(input.deployId, 16)}`
    : 'Get deploy';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isDeploy) {
    const d = parsed as RenderDeploy;
    const variant =
      d.status === 'live'
        ? 'success'
        : d.status === 'deploying'
          ? 'info'
          : d.status?.includes('failed') || d.status?.includes('error')
            ? 'error'
            : 'gray';
    badge = <Badge text={d.status || 'unknown'} variant={variant} />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isDeploy && <DeployDetailBlock deploy={parsed as RenderDeploy} />}
        {!isDeploy && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function TriggerDeployRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; deployId?: string; status?: string; createdAt?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'deployId' in parsed;

  let description = input?.serviceId
    ? `Deploy ${truncate(input.serviceId, 20)}`
    : 'Trigger deploy';
  if (input?.clearCache === 'clear') description += ' (clear cache)';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="triggered" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; deployId?: string; status?: string; createdAt?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.deployId && <KeyValueRow label="Deploy ID" value={result.deployId} mono />}
            {result.status && <KeyValueRow label="Status" value={result.status} />}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CancelDeployRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRenderColors();
  const parsed = output ? parseOutput<{ message?: string; cancelled?: boolean }>(output) : null;
  const isSuccess = isSuccessOutput(parsed);

  const description = input?.deployId
    ? `Cancel deploy ${truncate(input.deployId, 16)}`
    : 'Cancel deploy';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="cancelled" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isSuccess && result?.message && <SuccessBlock message={result.message} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function RollbackDeployRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; newDeployId?: string; status?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'newDeployId' in parsed;

  const description = input?.deployId
    ? `Rollback to ${truncate(input.deployId, 16)}`
    : 'Rollback deploy';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="rolled back" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; newDeployId?: string; status?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.newDeployId && (
              <KeyValueRow label="New Deploy" value={result.newDeployId} mono />
            )}
            {result.status && <KeyValueRow label="Status" value={result.status} />}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
