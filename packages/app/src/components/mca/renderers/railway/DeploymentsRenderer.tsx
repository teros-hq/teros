/**
 * Railway Renderer - Deployments & Logs
 *
 * Handles: railway-list-deployments, railway-get-deployment, railway-redeploy,
 *          railway-get-build-logs, railway-get-deploy-logs
 */

import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRailwayColors,
  DeployStatusBadge,
  getDeployStatusColor,
  InfoRow,
  parseOutput,
  type RailwayDeployment,
  truncate,
  type DeployStatus,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface DeploymentRowProps {
  deployment: { id: string; status: string; createdAt?: string; url?: string };
  highlight?: boolean;
}

function DeploymentRow({ deployment, highlight }: DeploymentRowProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const statusColor = getDeployStatusColor(deployment.status as DeployStatus);

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      backgroundColor={highlight ? 'rgba(229,77,46,0.08)' : 'transparent'}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      cursor={deployment.url ? 'pointer' : 'default'}
      onPress={() => deployment.url && Linking.openURL(deployment.url)}
    >
      <XStack
        width={6}
        height={6}
        borderRadius={3}
        backgroundColor={statusColor}
        flexShrink={0}
      />
      <Text color={c.text3} fontSize={8} fontFamily="$mono" width={80} numberOfLines={1}>
        {truncate(deployment.id, 12)}
      </Text>
      <DeployStatusBadge status={deployment.status as DeployStatus} />
      {deployment.createdAt && (
        <Text flex={1} color={c.text3} fontSize={8} textAlign="right" numberOfLines={1}>
          {new Date(deployment.createdAt).toLocaleDateString()}
        </Text>
      )}
    </XStack>
  );
}

interface DeploymentDetailBlockProps {
  deployment: RailwayDeployment;
}

function DeploymentDetailBlock({ deployment }: DeploymentDetailBlockProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const statusColor = getDeployStatusColor(deployment.status);
  const url = deployment.url || deployment.staticUrl;

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      <XStack alignItems="center" gap={8}>
        <XStack
          width={8}
          height={8}
          borderRadius={4}
          backgroundColor={statusColor}
          flexShrink={0}
        />
        <Text color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={1}>
          {truncate(deployment.id, 24)}
        </Text>
        <DeployStatusBadge status={deployment.status} />
      </XStack>

      {deployment.createdAt && (
        <InfoRow label="created" value={new Date(deployment.createdAt).toLocaleString()} />
      )}
      {deployment.updatedAt && (
        <InfoRow label="updated" value={new Date(deployment.updatedAt).toLocaleString()} />
      )}
      {url && (
        <XStack
          alignItems="center"
          gap={6}
          cursor="pointer"
          onPress={() => Linking.openURL(url)}
          hoverStyle={{ opacity: 0.7 }}
        >
          <Text color={colors.railwayRed} fontSize={9} fontFamily="$mono" numberOfLines={1}>
            {url}
          </Text>
        </XStack>
      )}
    </YStack>
  );
}

// Parse deployments from markdown text output
function parseDeploymentsFromMarkdown(
  text: string,
): Array<{ id: string; status: string; createdAt?: string; url?: string }> {
  const results: Array<{ id: string; status: string; createdAt?: string; url?: string }> = [];
  // Match lines like: - **id**: STATUS (date) - url
  const regex = /- \*\*([^*]+)\*\*:\s*(\w+)\s*\(([^)]+)\)(?:\s*-\s*(\S+))?/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({
      id: match[1],
      status: match[2],
      createdAt: match[3],
      url: match[4],
    });
  }
  return results;
}

// ============================================================================
// Renderers
// ============================================================================

export function ListDeploymentsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const deployments = typeof parsed === 'string' ? parseDeploymentsFromMarkdown(parsed) : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && deployments.length > 0) {
    badge = <Badge text={`${deployments.length} deploys`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List deployments';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {deployments.length > 0 && (
          <ScrollView
            style={{ maxHeight: 240, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {deployments.map((d) => (
                <DeploymentRow key={d.id} deployment={d} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {typeof parsed === 'string' && deployments.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>
              {parsed}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetDeploymentRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<RailwayDeployment>(output) : null;
  const isDeployment =
    parsed && typeof parsed === 'object' && 'status' in parsed && 'id' in parsed;

  const deployStatus = isDeployment ? (parsed as RailwayDeployment).status : undefined;

  let badge: React.ReactNode = null;
  if (status === 'completed' && deployStatus) {
    badge = <DeployStatusBadge status={deployStatus} />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.deploymentId
    ? `Get deploy ${truncate(input.deploymentId, 14)}`
    : 'Get deployment';

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isDeployment && <DeploymentDetailBlock deployment={parsed as RailwayDeployment} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function RedeployRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<{ message: string; deploymentId: string; status: string }>(output) : null;
  const isResult =
    parsed && typeof parsed === 'object' && 'message' in parsed;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="triggered" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.deploymentId
    ? `Redeploy ${truncate(input.deploymentId, 14)}`
    : 'Redeploy';

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <SuccessBlock message={(parsed as { message: string }).message} />
        )}
        {isResult && (parsed as any).deploymentId && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            <InfoRow label="deploy id" value={(parsed as any).deploymentId} mono />
            {(parsed as any).status && (
              <InfoRow label="status" value={(parsed as any).status} />
            )}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetBuildLogsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;

  // Extract line count from text
  let lineCount: number | null = null;
  if (typeof parsed === 'string') {
    const match = parsed.match(/\((\d+) lines\)/);
    if (match) lineCount = parseInt(match[1], 10);
  }

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = lineCount !== null
      ? <Badge text={`${lineCount} lines`} variant="gray" />
      : <Badge text="logs" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.deploymentId
    ? `Build logs ${truncate(input.deploymentId, 12)}`
    : 'Build logs';

  


  // Extract just the log lines from the code block
  let logContent = typeof parsed === 'string' ? parsed : '';
  const codeMatch = logContent.match(/```\n([\s\S]+)\n```/);
  if (codeMatch) logContent = codeMatch[1];

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {logContent && (
          <ScrollView
            style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack padding={8}>
              <Text color={c.text2} fontSize={8} fontFamily="$mono">
                {logContent}
              </Text>
            </YStack>
          </ScrollView>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetDeployLogsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;

  let lineCount: number | null = null;
  if (typeof parsed === 'string') {
    const match = parsed.match(/\((\d+) lines\)/);
    if (match) lineCount = parseInt(match[1], 10);
  }

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = lineCount !== null
      ? <Badge text={`${lineCount} lines`} variant="gray" />
      : <Badge text="logs" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.deploymentId
    ? `Runtime logs ${truncate(input.deploymentId, 12)}`
    : 'Runtime logs';

  


  let logContent = typeof parsed === 'string' ? parsed : '';
  const codeMatch = logContent.match(/```\n([\s\S]+)\n```/);
  if (codeMatch) logContent = codeMatch[1];

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {logContent && (
          <ScrollView
            style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack padding={8}>
              <Text color={c.text2} fontSize={8} fontFamily="$mono">
                {logContent}
              </Text>
            </YStack>
          </ScrollView>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
