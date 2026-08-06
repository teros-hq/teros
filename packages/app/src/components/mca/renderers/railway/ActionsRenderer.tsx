/**
 * Railway Renderer - Actions
 *
 * Handles: railway-create-project, railway-delete-project,
 *          railway-create-environment, railway-create-service, railway-delete-service,
 *          railway-connect-repo, railway-deploy-public-repo, railway-create-volume
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRailwayColors,
  InfoRow,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Renderers
// ============================================================================

export function CreateProjectRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{
        message: string;
        projectId: string;
        name: string;
        environments?: Array<{ id: string; name: string }>;
      }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'projectId' in parsed;

  const projectName = isResult ? (parsed as any).name : input?.name;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = projectName
    ? `Create project: ${truncate(projectName, 25)}`
    : 'Create project';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="project id" value={result.projectId} mono />
              <InfoRow label="name" value={result.name} />
              {result.environments && result.environments.length > 0 && (
                <XStack gap={4} alignItems="center">
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" width={80}>
                    envs
                  </Text>
                  <XStack gap={4} flexWrap="wrap">
                    {result.environments.map((e: any, i: number) => (
                      <Badge key={i} text={e.name} variant="gray" />
                    ))}
                  </XStack>
                </XStack>
              )}
            </YStack>
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeleteProjectRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{ message: string; deleted: boolean }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'deleted' in parsed;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.projectId
    ? `Delete project ${truncate(input.projectId, 16)}`
    : 'Delete project';

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && <SuccessBlock message={(parsed as any).message} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateEnvironmentRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{ message: string; environmentId: string; name: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'environmentId' in parsed;

  const envName = isResult ? (parsed as any).name : input?.name;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = envName
    ? `Create env: ${truncate(envName, 25)}`
    : 'Create environment';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="env id" value={result.environmentId} mono />
              <InfoRow label="name" value={result.name} />
            </YStack>
          </>
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
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{ message: string; serviceId: string; name: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'serviceId' in parsed;

  const svcName = isResult ? (parsed as any).name : input?.name;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = svcName
    ? `Create service: ${truncate(svcName, 22)}`
    : 'Create service';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="service id" value={result.serviceId} mono />
              <InfoRow label="name" value={result.name} />
            </YStack>
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeleteServiceRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{ message: string; deleted: boolean }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'deleted' in parsed;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = input?.serviceId
    ? `Delete service ${truncate(input.serviceId, 16)}`
    : 'Delete service';

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && <SuccessBlock message={(parsed as any).message} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ConnectRepoRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{
        message: string;
        serviceId: string;
        serviceName: string;
        repo: string;
        branch: string;
        note?: string;
      }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'repo' in parsed;

  const repoName = isResult ? (parsed as any).repo : input?.repo;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="connected" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = repoName
    ? `Connect: ${truncate(repoName, 28)}`
    : 'Connect repo';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="repo" value={result.repo} mono />
              <InfoRow label="branch" value={result.branch} mono />
              <InfoRow label="service" value={result.serviceName || result.serviceId} />
            </YStack>
            {result.note && (
              <XStack
                backgroundColor="rgba(251,191,36,0.08)"
                borderRadius={5}
                padding={8}
                borderWidth={1}
                borderColor="rgba(251,191,36,0.15)"
              >
                <Text color={c.badges.warn.text} fontSize={9}>
                  {result.note}
                </Text>
              </XStack>
            )}
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeployPublicRepoRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{
        message: string;
        serviceId: string;
        repo: string;
        branch: string;
        note?: string;
      }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'repo' in parsed;

  const repoName = isResult ? (parsed as any).repo : input?.repo;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deployed" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = repoName
    ? `Deploy: ${truncate(repoName, 28)}`
    : 'Deploy public repo';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="repo" value={result.repo} mono />
              <InfoRow label="branch" value={result.branch} mono />
              <InfoRow label="service id" value={result.serviceId} mono />
            </YStack>
            {result.note && (
              <XStack
                backgroundColor="rgba(251,191,36,0.08)"
                borderRadius={5}
                padding={8}
                borderWidth={1}
                borderColor="rgba(251,191,36,0.15)"
              >
                <Text color={c.badges.warn.text} fontSize={9}>
                  {result.note}
                </Text>
              </XStack>
            )}
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateVolumeRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const parsed = output
    ? parseOutput<{ message: string; volumeId: string; name: string; mountPath: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && 'volumeId' in parsed;

  const mountPath = isResult ? (parsed as any).mountPath : input?.mountPath;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = mountPath
    ? `Volume: ${truncate(mountPath, 28)}`
    : 'Create volume';

  


  const result = parsed as any;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <>
            <SuccessBlock message={result.message} />
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
              <InfoRow label="volume id" value={result.volumeId} mono />
              <InfoRow label="name" value={result.name} />
              <InfoRow label="mount" value={result.mountPath} mono />
            </YStack>
          </>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
