/**
 * Render MCA Renderer - Actions & Misc
 *
 * Handles:
 *   - render-get-user, render-list-owners
 *   - render-list-projects, render-get-project, render-create-project, render-delete-project
 *   - render-list-environments, render-create-environment
 *   - render-suspend-service, render-resume-service, render-restart-service, render-delete-service
 *   - render-get-logs
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRenderColors,
  formatDate,
  formatRelativeTime,
  isSuccessOutput,
  KeyValueRow,
  parseOutput,
  type RenderEnvironment,
  type RenderLogEntry,
  type RenderOwner,
  type RenderProject,
  type RenderUser,
  truncate,
} from './shared';

// ============================================================================
// User & Owners
// ============================================================================

export function GetUserRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderUser>(output) : null;
  const isUser =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'email' in parsed;

  const description = 'Get Render user';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isUser) {
    badge = <Badge text={(parsed as RenderUser).name || 'user'} variant="info" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const user = parsed as RenderUser | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isUser && user && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            <KeyValueRow label="Name" value={user.name} />
            {user.email && <KeyValueRow label="Email" value={user.email} />}
            <KeyValueRow label="ID" value={user.id} mono />
          </YStack>
        )}
        {!isUser && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListOwnersRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderOwner[]>(output) : null;
  const owners = Array.isArray(parsed) ? parsed : null;
  const isOwnerArray = Array.isArray(owners) && owners.length > 0 && 'type' in owners[0];

  const description = 'List owners';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isOwnerArray) {
    badge = <Badge text={`${owners!.length} owners`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isOwnerArray && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {owners!.map((o) => (
              <XStack
                key={o.id}
                alignItems="center"
                gap={8}
                paddingVertical={4}
                paddingHorizontal={8}
              >
                <Text flex={1} color={c.text} fontSize={10} fontWeight="500">
                  {o.name}
                </Text>
                <Badge text={o.type || 'personal'} variant="gray" />
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  {truncate(o.id, 16)}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
        {!isOwnerArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

// ============================================================================
// Projects
// ============================================================================

export function ListProjectsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderProject[]>(output) : null;
  const projects = Array.isArray(parsed) ? parsed : null;
  const isProjectArray = Array.isArray(projects) && projects.length > 0 && 'name' in projects[0];

  const description = 'List projects';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isProjectArray) {
    badge = <Badge text={`${projects!.length} projects`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isProjectArray && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {projects!.map((p) => (
              <XStack
                key={p.id}
                alignItems="center"
                gap={8}
                paddingVertical={4}
                paddingHorizontal={8}
                hoverStyle={{ backgroundColor: c.bgCardHover }}
              >
                <Text flex={1} color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>
                  {p.name}
                </Text>
                {p.createdAt && (
                  <Text color={c.text3} fontSize={9}>
                    {formatDate(p.createdAt)}
                  </Text>
                )}
              </XStack>
            ))}
          </YStack>
        )}
        {!isProjectArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetProjectRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderProject>(output) : null;
  const isProject =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'name' in parsed && 'ownerId' in parsed;

  const description = input?.projectId
    ? `Get project ${truncate(input.projectId, 20)}`
    : 'Get project';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isProject) {
    badge = <Badge text={(parsed as RenderProject).name} variant="info" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const project = parsed as RenderProject | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isProject && project && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            <KeyValueRow label="Name" value={project.name} />
            <KeyValueRow label="ID" value={project.id} mono />
            {project.ownerId && <KeyValueRow label="Owner ID" value={project.ownerId} mono />}
            {project.createdAt && (
              <KeyValueRow label="Created" value={formatDate(project.createdAt)} />
            )}
            {project.updatedAt && (
              <KeyValueRow label="Updated" value={formatRelativeTime(project.updatedAt)} />
            )}
          </YStack>
        )}
        {!isProject && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateProjectRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; projectId?: string; name?: string; ownerId?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'projectId' in parsed;

  const description = input?.name
    ? `Create project: ${truncate(input.name, 30)}`
    : 'Create project';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; projectId?: string; name?: string; ownerId?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.name && <KeyValueRow label="Name" value={result.name} />}
            {result.projectId && <KeyValueRow label="Project ID" value={result.projectId} mono />}
          </YStack>
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
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; deleted?: boolean }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed);

  const description = input?.projectId
    ? `Delete project ${truncate(input.projectId, 20)}`
    : 'Delete project';

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

// ============================================================================
// Environments
// ============================================================================

export function ListEnvironmentsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<RenderEnvironment[]>(output) : null;
  const envs = Array.isArray(parsed) ? parsed : null;
  const isEnvArray = Array.isArray(envs) && envs.length > 0 && 'name' in envs[0];

  const description = input?.projectId
    ? `Environments for ${truncate(input.projectId, 20)}`
    : 'List environments';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isEnvArray) {
    badge = <Badge text={`${envs!.length} envs`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isEnvArray && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {envs!.map((e) => (
              <XStack
                key={e.id}
                alignItems="center"
                gap={8}
                paddingVertical={4}
                paddingHorizontal={8}
              >
                <Text flex={1} color={c.text} fontSize={10} fontWeight="500">
                  {e.name}
                </Text>
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  {truncate(e.id, 16)}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}
        {!isEnvArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
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
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; environmentId?: string; name?: string; projectId?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'environmentId' in parsed;

  const description = input?.name
    ? `Create env: ${truncate(input.name, 25)}`
    : 'Create environment';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; environmentId?: string; name?: string; projectId?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.name && <KeyValueRow label="Name" value={result.name} />}
            {result.environmentId && (
              <KeyValueRow label="Env ID" value={result.environmentId} mono />
            )}
            {result.projectId && (
              <KeyValueRow label="Project ID" value={result.projectId} mono />
            )}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

// ============================================================================
// Service lifecycle actions
// ============================================================================

function ServiceActionRenderer({
  input,
  status,
  appIcon,
  output,
  error,
  actionLabel,
  badgeVariant,
}: ToolCallRendererProps & { actionLabel: string; badgeVariant: 'success' | 'warning' | 'error' | 'info' | 'gray' | 'orange' }) {
  const parsed = output
    ? parseOutput<{ message?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed);

  const description = input?.serviceId
    ? `${actionLabel} ${truncate(input.serviceId, 20)}`
    : actionLabel;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={actionLabel.toLowerCase()} variant={badgeVariant} />;
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

export function SuspendServiceRenderer(props: ToolCallRendererProps) {
  const colors = useRenderColors();
  return <ServiceActionRenderer {...props} actionLabel="Suspend" badgeVariant="orange" />;
}

export function ResumeServiceRenderer(props: ToolCallRendererProps) {
  const colors = useRenderColors();
  return <ServiceActionRenderer {...props} actionLabel="Resume" badgeVariant="success" />;
}

export function RestartServiceRenderer(props: ToolCallRendererProps) {
  const colors = useRenderColors();
  return <ServiceActionRenderer {...props} actionLabel="Restart" badgeVariant="info" />;
}

export function DeleteServiceRenderer(props: ToolCallRendererProps) {
  const colors = useRenderColors();
  return <ServiceActionRenderer {...props} actionLabel="Delete" badgeVariant="error" />;
}

// ============================================================================
// Logs
// ============================================================================

function LogLevelBadge({ level }: { level?: string }) {
  const colors = useRenderColors();
  if (!level) return null;
  const lower = level.toLowerCase();
  const variant =
    lower === 'error'
      ? 'error'
      : lower === 'warning' || lower === 'warn'
        ? 'warning'
        : lower === 'debug'
          ? 'gray'
          : 'info';

  return <Badge text={lower} variant={variant} />;
}

export function GetLogsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output ? parseOutput<{ logs?: RenderLogEntry[] } | RenderLogEntry[]>(output) : null;

  const logs = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'logs' in parsed
      ? (parsed as { logs: RenderLogEntry[] }).logs
      : null;

  const isLogArray = Array.isArray(logs) && logs.length > 0;

  const serviceCount = Array.isArray(input?.serviceIds) ? input.serviceIds.length : 1;
  const description = `Logs${serviceCount > 1 ? ` (${serviceCount} services)` : ''}`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isLogArray) {
    badge = <Badge text={`${logs!.length} lines`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isLogArray && (
          <ScrollView
            style={{
              maxHeight: 300,
              backgroundColor: c.bgInner,
              borderRadius: 5,
            }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4} paddingHorizontal={8} gap={2}>
              {logs!.map((entry, idx) => (
                <XStack key={entry.id || idx} alignItems="flex-start" gap={6}>
                  {/* Timestamp */}
                  {entry.timestamp && (
                    <Text
                      color={c.text3}
                      fontSize={8}
                      fontFamily="$mono"
                      width={55}
                      flexShrink={0}
                      marginTop={1}
                    >
                      {formatRelativeTime(entry.timestamp)}
                    </Text>
                  )}

                  {/* Level */}
                  {entry.level && (
                    <XStack flexShrink={0} marginTop={1}>
                      <LogLevelBadge level={entry.level} />
                    </XStack>
                  )}

                  {/* Message */}
                  <Text color={c.text2} fontSize={9} fontFamily="$mono" flex={1}>
                    {entry.message || ''}
                  </Text>
                </XStack>
              ))}
            </YStack>
          </ScrollView>
        )}
        {!isLogArray && typeof parsed === 'string' && (
          <ScrollView
            style={{
              maxHeight: 250,
              backgroundColor: c.bgInner,
              borderRadius: 5,
            }}
            showsVerticalScrollIndicator
          >
            <Text
              color={c.text2}
              fontSize={9}
              fontFamily="$mono"
              padding={8}
            >
              {parsed}
            </Text>
          </ScrollView>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
