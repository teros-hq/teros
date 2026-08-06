/**
 * Docker Environments MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Docker Environment tool calls.
 * Renders environment operations with minimal footprint when collapsed,
 * expandable to show full details.
 *
 * Design based on WhatsApp renderer pattern with:
 * - Status dot with glow effect (+ purple "creating" state)
 * - App icon from manifest (be.teros.ai static)
 * - Contextual badges (running, stopped, exit code, line count…)
 * - Collapsed/expanded views
 * - Environment list with inline status pills
 * - Log viewer with timestamp/service/message coloring
 * - Exec output with stdout/stderr blocks
 */

import type React from 'react';
import {   ScrollView } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { colors as semantic, ToolCallCard, useColors } from '../primitives';

// Docker Environments icon from MCA manifest static folder
const DOCKER_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.teros.docker-env/icon.png`;

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================
// Hook for the Docker palette. Status dot + creating violet + log accents
// are semantic theme-agnostic; surface + text + border come from
// `useColors()` and switch with the Tamagui theme.

function useDockerColors() {
  const c = useColors();
  return {
    // Status dot (semantic theme-agnostic)
    success: semantic.green,
    running: semantic.indigo,
    failed: semantic.red,
    creating: semantic.violet,

    // Status glow
    glowSuccess: 'rgba(34, 197, 94, 0.5)',
    glowRunning: 'rgba(94, 106, 210, 0.7)',
    glowFailed: 'rgba(239, 68, 68, 0.5)',
    glowCreating: 'rgba(139, 92, 246, 0.6)',

    // Badges (theme-adaptive)
    badgeGray: c.badges.gray,
    badgeGreen: c.badges.ok,
    badgeBlue: c.badges.info,
    badgePurple: { text: '#c4b5fd', bg: 'rgba(139,92,246,0.1)' },
    badgeRed: c.badges.err,
    badgeOrange: { text: '#fdba74', bg: 'rgba(249,115,22,0.1)' },

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    borderLight: c.borderStrong,

    // Log colors — MCA-specific accent set, intentionally not in global tokens
    logTs: c.text3,
    logSvc: semantic.violet,
    logMsg: c.text2,
    logErr: c.badges.err.text,

    // Chevron (theme-adaptive)
    chevron: c.text3,

    ...c,  // spread all adaptive tokens (text, text2, text3, bgInner, badges, etc.)
  };
}

// ============================================================================
// Utilities
// ============================================================================

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/** Derive the last segment of a path for display: /workspace/my-project → my-project */
function pathLabel(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || p;
}

// ============================================================================
// Shared Components
// ============================================================================

type DotStatus = 'running' | 'completed' | 'failed' | 'creating';



type BadgeVariant = 'gray' | 'green' | 'blue' | 'purple' | 'red' | 'orange';

interface BadgeProps {
  text: string;
  variant: BadgeVariant;
}

function Badge({ text, variant }: BadgeProps) {
  const c = useDockerColors();
  const colorMap: Record<BadgeVariant, { text: string; bg: string }> = {
    gray:   c.badges.gray,
    green:  c.badgeGreen,
    blue:   c.badgeBlue,
    purple: c.badgePurple,
    red:    c.badgeRed,
    orange: c.badgeOrange,
  };
  const { text: textColor, bg } = colorMap[variant];
  return (
    <XStack backgroundColor={bg} paddingHorizontal={5} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}





/** Simple key/value row inside a dark block */
function KVBlock({ rows }: { rows: { key: string; value: React.ReactNode }[] }) {
  const c = useDockerColors();
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
      {rows.map(({ key, value }) => (
        <XStack key={key} alignItems="flex-start" gap={6}>
          <Text color={c.text3} fontSize={9} width={54} flexShrink={0} paddingTop={1}>
            {key}
          </Text>
          <XStack flex={1} flexWrap="wrap">
            {typeof value === 'string' || typeof value === 'number' ? (
              <Text color={c.text2} fontSize={10} flex={1} numberOfLines={2}>
                {value}
              </Text>
            ) : (
              value
            )}
          </XStack>
        </XStack>
      ))}
    </YStack>
  );
}

// ============================================================================
// Output Types
// ============================================================================

interface DockerEnv {
  envId?: string;
  status?: string;
  localPath?: string;
  urls?: string[];
  services?: string[];
  createdAt?: string;
  error?: string;
}

interface DockerExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

// ============================================================================
// Sub-Renderer props
// ============================================================================

interface SubRendererProps extends ToolCallRendererProps {
}

// ============================================================================
// Helpers: status → dot + badge
// ============================================================================

function envStatusToDot(envStatus?: string, toolStatus?: string): DotStatus {
  if (toolStatus === 'failed') return 'failed';
  if (toolStatus === 'running') return 'running';
  switch (envStatus) {
    case 'running': return 'completed';
    case 'stopped': case 'error': return 'failed';
    case 'creating': case 'building': return 'creating';
    default: return 'completed';
  }
}

function envStatusToBadge(envStatus?: string, toolStatus?: string): { text: string; variant: BadgeVariant } | undefined {
  if (toolStatus === 'failed') return { text: 'failed', variant: 'red' };
  if (!envStatus) return undefined;
  switch (envStatus) {
    case 'running':  return { text: 'running',  variant: 'green' };
    case 'stopped':  return { text: 'stopped',  variant: 'gray' };
    case 'creating': return { text: 'creating', variant: 'purple' };
    case 'building': return { text: 'building', variant: 'purple' };
    case 'error':    return { text: 'error',     variant: 'red' };
    default:         return { text: envStatus,   variant: 'gray' };
  }
}

// ============================================================================
// env-create
// ============================================================================

function EnvCreateRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<DockerEnv>(output);
  const localPath: string = input?.localPath || '';
  const label = pathLabel(localPath) || 'new environment';

  const isCreating = status === 'running';
  const envStatus = data?.status;
  const dotStatus: DotStatus = status === 'failed' ? 'failed' : isCreating ? 'creating' : envStatusToDot(envStatus);

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : !isCreating
      ? envStatusToBadge(envStatus)
      : undefined;

  const activeLabel = isCreating ? 'building…' : undefined;

  const headerProps: ToolShellHeaderProps = {
    dotStatus,
    description: `Create environment · ${truncate(label, 24)}`,
    duration: isCreating ? undefined : duration,
    badge,
    activeLabel,
    activeLabelColor: c.creating,
  };
  const kvRows: { key: string; value: React.ReactNode }[] = [];
  if (localPath) kvRows.push({ key: 'path', value: <Text color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={1}>{localPath}</Text> });
  if (input?.composeFile && input.composeFile !== 'docker-compose.yml') kvRows.push({ key: 'compose', value: <Text color={c.text} fontSize={10} fontFamily="$mono">{input.composeFile}</Text> });
  if (data?.envId) kvRows.push({ key: 'envId', value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{data.envId}</Text> });
  if (envStatus) kvRows.push({
    key: 'status',
    value: <Text
      color={envStatus === 'running' ? c.success : envStatus === 'creating' ? c.creating : c.text2}
      fontSize={10} fontWeight="500"
    >{envStatus}</Text>,
  });
  if (data?.urls?.length) kvRows.push({ key: 'url', value: <UrlChip url={data.urls[0]} /> });
  if (status === 'failed') kvRows.push({ key: 'error', value: <Text color={c.logErr} fontSize={10} flex={1}>{error || data?.error || output || 'Unknown error'}</Text> });

  return (
    <ToolShell {...headerProps}>
        {kvRows.length > 0 && <KVBlock rows={kvRows} />}
        {data?.services && data.services.length > 0 && <ServicesRow services={data.services} />}
      </ToolShell>
  );
}

// ============================================================================
// env-status
// ============================================================================

function EnvStatusRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<DockerEnv & { buildLogs?: string[] }>(output);
  const envId: string = input?.envId || data?.envId || '';
  const envStatus = data?.status;

  const dotStatus: DotStatus = status === 'failed' ? 'failed' : envStatusToDot(envStatus);
  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : envStatusToBadge(envStatus);

  const headerProps: ToolShellHeaderProps = {
    dotStatus,
    description: `Environment status · ${truncate(envId, 16)}`,
    duration,
    badge,
  };
  const kvRows: { key: string; value: React.ReactNode }[] = [];
  if (envId) kvRows.push({ key: 'envId', value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{envId}</Text> });
  if (envStatus) kvRows.push({
    key: 'status',
    value: <Text
      color={envStatus === 'running' ? c.success : envStatus === 'error' ? c.failed : envStatus === 'creating' ? c.creating : c.text2}
      fontSize={10} fontWeight="500"
    >{envStatus}</Text>,
  });
  if (data?.urls?.length) kvRows.push({ key: 'url', value: <UrlChip url={data.urls[0]} /> });
  if (status === 'failed') kvRows.push({ key: 'error', value: <Text color={c.logErr} fontSize={10} flex={1}>{error || output || 'Unknown error'}</Text> });

  // Build logs (shown when still creating)
  const buildLogs = (data as any)?.buildLogs as string[] | undefined;

  return (
    <ToolShell {...headerProps}>
        {kvRows.length > 0 && <KVBlock rows={kvRows} />}
        {data?.services && data.services.length > 0 && <ServicesRow services={data.services} />}
        {buildLogs && buildLogs.length > 0 && (
          <LogBlock lines={buildLogs} label="build log" />
        )}
      </ToolShell>
  );
}

// ============================================================================
// env-exec
// ============================================================================

function EnvExecRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<DockerExecResult>(output);
  const envId: string = input?.envId || '';
  const service: string = input?.service || '';
  const command: string = input?.command || '';
  const exitCode = data?.exitCode;

  const isRunning = status === 'running';
  const dotStatus: DotStatus = status === 'failed' ? 'failed' : isRunning ? 'running' : exitCode === 0 ? 'completed' : 'failed';

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : !isRunning && exitCode !== undefined
      ? { text: `exit ${exitCode}`, variant: exitCode === 0 ? 'green' : 'red' as BadgeVariant }
      : undefined;

  const headerProps: ToolShellHeaderProps = {
    dotStatus,
    description: `exec · ${service} · ${truncate(command, 24)}`,
    duration: isRunning ? undefined : duration,
    badge,
    activeLabel: isRunning ? 'running…' : undefined,
  };
  const kvRows: { key: string; value: React.ReactNode }[] = [
    { key: 'envId',    value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{envId}</Text> },
    { key: 'service',  value: <Text color={c.text} fontSize={10}>{service}</Text> },
    { key: 'command',  value: <Text color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={2}>{command}</Text> },
  ];
  if (!isRunning && exitCode !== undefined) {
    kvRows.push({
      key: 'exit',
      value: <Text color={exitCode === 0 ? c.success : c.failed} fontSize={10} fontWeight="600">{exitCode}</Text>,
    });
  }

  return (
    <ToolShell {...headerProps}>
        <KVBlock rows={kvRows} />
        {!isRunning && (data?.stdout || data?.stderr) && (
          <ExecOutputBlock stdout={data?.stdout} stderr={data?.stderr} />
        )}
        {status === 'failed' && !data && (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.logErr} fontSize={10}>{error || output || 'Unknown error'}</Text>
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// env-logs
// ============================================================================

function EnvLogsRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<{ logs?: string[]; lines?: string[] } | string[]>(output);
  const rawLines: string[] = Array.isArray(data)
    ? data
    : (data as any)?.logs ?? (data as any)?.lines ?? [];

  // If output is a plain string (newline-separated logs), split it
  const lines: string[] = rawLines.length > 0
    ? rawLines
    : (output && !output.startsWith('{') ? output.split('\n').filter(Boolean) : []);

  const service: string = input?.service || '';
  const count = lines.length;

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : { text: `${count} line${count !== 1 ? 's' : ''}`, variant: 'gray' as BadgeVariant };

  const headerProps: ToolShellHeaderProps = {
    dotStatus: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'completed',
    description: service ? `Logs · ${truncate(input?.envId || '', 12)} · ${service}` : `Logs · ${truncate(input?.envId || '', 20)}`,
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
        <KVBlock rows={[
          { key: 'envId', value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{input?.envId || ''}</Text> },
          ...(service ? [{ key: 'service', value: <Text color={c.text} fontSize={10}>{service}</Text> }] : []),
        ]} />
        {status === 'failed' ? (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.logErr} fontSize={10}>{error || output || 'Unknown error'}</Text>
          </YStack>
        ) : lines.length > 0 ? (
          <LogBlock lines={lines} />
        ) : status === 'running' ? (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.text3} fontSize={10}>Fetching logs…</Text>
          </YStack>
        ) : (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.text3} fontSize={10}>No logs found</Text>
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// env-list
// ============================================================================

function EnvListRenderer({ status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<{ environments?: DockerEnv[] } | DockerEnv[]>(output);
  const envs: DockerEnv[] = Array.isArray(data) ? data : (data as any)?.environments ?? [];
  const count = envs.length;

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : { text: `${count} env${count !== 1 ? 's' : ''}`, variant: 'gray' as BadgeVariant };

  const headerProps: ToolShellHeaderProps = {
    dotStatus: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'completed',
    description: 'List environments',
    duration,
    badge,
  };
  return (
    <ToolShell {...headerProps}>
        {status === 'running' ? (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.text3} fontSize={10}>Loading environments…</Text>
          </YStack>
        ) : status === 'failed' ? (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.logErr} fontSize={10}>{error || output || 'Unknown error'}</Text>
          </YStack>
        ) : envs.length > 0 ? (
          <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
            {envs.slice(0, 10).map((env, idx) => (
              <XStack
                key={env.envId || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < envs.length - 1 ? 1 : 0}
                borderBottomColor={c.border}
              >
                <YStack flex={1} minWidth={0}>
                  <Text color={c.text} fontSize={10} fontWeight="500" numberOfLines={1}>
                    {pathLabel(env.localPath) || env.envId || 'Unknown'}
                  </Text>
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" numberOfLines={1}>
                    {env.envId || ''}
                  </Text>
                </YStack>
                <EnvStatusPill status={env.status} />
              </XStack>
            ))}
          </YStack>
        ) : (
          <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
            <Text color={c.text3} fontSize={10}>No environments found</Text>
          </YStack>
        )}
        {count > 10 && (
          <XStack justifyContent="flex-end">
            <Text color={c.text3} fontSize={9} fontFamily="$mono">{count} environments total</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// env-restart
// ============================================================================

function EnvRestartRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const data = parseOutput<DockerEnv>(output);
  const envId: string = input?.envId || '';
  const isRunning = status === 'running';

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : !isRunning && data?.status
      ? envStatusToBadge(data.status)
      : undefined;

  const headerProps: ToolShellHeaderProps = {
    dotStatus: status === 'failed' ? 'failed' : isRunning ? 'running' : 'completed',
    description: `Restart · ${truncate(envId, 20)}`,
    duration: isRunning ? undefined : duration,
    badge,
    activeLabel: isRunning ? 'restarting…' : undefined,
  };
  const kvRows: { key: string; value: React.ReactNode }[] = [
    { key: 'envId', value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{envId}</Text> },
    { key: 'rebuild', value: <Text color={c.text2} fontSize={10} fontFamily="$mono">{String(input?.rebuild ?? false)}</Text> },
  ];
  if (data?.status) kvRows.push({
    key: 'status',
    value: <Text color={data.status === 'running' ? c.success : c.text2} fontSize={10} fontWeight="500">{data.status}</Text>,
  });
  if (status === 'failed') kvRows.push({ key: 'error', value: <Text color={c.logErr} fontSize={10} flex={1}>{error || output || 'Unknown error'}</Text> });

  return (
    <ToolShell {...headerProps}>
        <KVBlock rows={kvRows} />
      </ToolShell>
  );
}

// ============================================================================
// env-destroy
// ============================================================================

function EnvDestroyRenderer({ input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const envId: string = input?.envId || '';
  const isRunning = status === 'running';

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : !isRunning && status === 'completed'
      ? { text: 'destroyed', variant: 'red' as BadgeVariant }
      : undefined;

  const headerProps: ToolShellHeaderProps = {
    dotStatus: status === 'failed' ? 'failed' : isRunning ? 'running' : 'completed',
    description: `Destroy · ${truncate(envId, 20)}`,
    duration: isRunning ? undefined : duration,
    badge,
    activeLabel: isRunning ? 'destroying…' : undefined,
  };
  const kvRows: { key: string; value: React.ReactNode }[] = [
    { key: 'envId', value: <Text color={c.text2} fontSize={9} fontFamily="$mono">{envId}</Text> },
    { key: 'volumes', value: <Text color={c.text2} fontSize={10} fontFamily="$mono">{String(input?.removeVolumes ?? true)}</Text> },
  ];
  if (status === 'completed') kvRows.push({
    key: 'status',
    value: <Text color={c.logErr} fontSize={10} fontWeight="600">destroyed</Text>,
  });
  if (status === 'failed') kvRows.push({ key: 'error', value: <Text color={c.logErr} fontSize={10} flex={1}>{error || output || 'Unknown error'}</Text> });

  return (
    <ToolShell {...headerProps}>
        <KVBlock rows={kvRows} />
      </ToolShell>
  );
}

// ============================================================================
// Default renderer — generic key/value view
// ============================================================================

function DefaultDockerRenderer({ toolName, input, status, output, error, duration }: SubRendererProps) {
  const c = useDockerColors();
  const shortName = getShortToolName(toolName);

  const badge = status === 'failed'
    ? { text: 'failed', variant: 'red' as BadgeVariant }
    : status === 'completed'
      ? { text: 'done', variant: 'green' as BadgeVariant }
      : undefined;

  const headerProps: ToolShellHeaderProps = {
    dotStatus: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'completed',
    description: shortName.replace(/-/g, ' '),
    duration,
    badge,
  };
  const displayError = error || (status === 'failed' ? output : null);

  return (
    <ToolShell {...headerProps}>
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10} gap={4}>
          {input && Object.keys(input).length > 0 &&
            Object.entries(input).slice(0, 5).map(([key, value]) => (
              <XStack key={key} alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={54}>{key}</Text>
                <Text color={c.text2} fontSize={9} flex={1} numberOfLines={1}>
                  {/* Renderer UX Guide §0: objects → `{…}`, arrays → `[…]`. */}
                  {typeof value === 'string'
                    ? truncate(value, 60)
                    : Array.isArray(value)
                      ? value.length === 0 ? '[]' : `[…${value.length}]`
                      : value === null
                        ? 'null'
                        : typeof value === 'object' ? '{…}' : String(value)}
                </Text>
              </XStack>
            ))
          }
          {status === 'completed' && output && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={54}>result</Text>
              <Text color={c.text2} fontSize={9} flex={1} numberOfLines={2}>{truncate(output, 100)}</Text>
            </XStack>
          )}
          {status === 'failed' && displayError && (
            <XStack alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} width={54}>error</Text>
              <Text color={c.logErr} fontSize={10} flex={1}>{displayError}</Text>
            </XStack>
          )}
          {!input && !output && !displayError && (
            <Text color={c.text3} fontSize={10}>No details available</Text>
          )}
        </YStack>
      </ToolShell>
  );
}

// ============================================================================
// Auxiliary UI components
// ============================================================================

/** Inline status pill for env-list rows */
function EnvStatusPill({ status }: { status?: string }) {
  const c = useDockerColors();
  if (!status) return null;
  // Map runtime env status to a theme-adaptive badge palette entry.
  // creating / building use the renderer-local violet pair (not in
  // global badges); the rest reuse the canonical badge variants.
  const map: Record<string, { color: string; bg: string }> = {
    running: { color: c.badgeBlue.text, bg: c.badgeBlue.bg },
    stopped: { color: c.badges.gray.text, bg: c.badges.gray.bg },
    creating: { color: c.badgePurple.text, bg: c.badgePurple.bg },
    building: { color: c.badgePurple.text, bg: c.badgePurple.bg },
    error: { color: c.badgeRed.text, bg: c.badgeRed.bg },
  };
  const style = map[status] ?? { color: c.badges.gray.text, bg: c.badges.gray.bg };
  return (
    <XStack backgroundColor={style.bg} paddingHorizontal={5} paddingVertical={1} borderRadius={3} flexShrink={0}>
      <Text color={style.color} fontSize={9} fontFamily="$mono">{status}</Text>
    </XStack>
  );
}

/** Clickable URL chip */
function UrlChip({ url }: { url: string }) {
  const c = useDockerColors();
  return (
    <XStack
      backgroundColor={c.badgeBlue.bg}
      borderWidth={1}
      borderColor={c.badgeBlue.border}
      borderRadius={4}
      paddingHorizontal={6}
      paddingVertical={2}
      alignItems="center"
      gap={4}
    >
      <Text color={c.badgeBlue.text} fontSize={9} fontFamily="$mono" numberOfLines={1}>{url}</Text>
    </XStack>
  );
}

/** Service chips row */
function ServicesRow({ services }: { services: string[] }) {
  const c = useDockerColors();
  return (
    <XStack flexWrap="wrap" gap={4}>
      {services.map((svc) => (
        <XStack
          key={svc}
          backgroundColor="rgba(139,92,246,0.08)"
          borderWidth={1}
          borderColor="rgba(139,92,246,0.15)"
          borderRadius={3}
          paddingHorizontal={5}
          paddingVertical={1}
        >
          <Text color={c.badgePurple.text} fontSize={9} fontFamily="$mono">{svc}</Text>
        </XStack>
      ))}
    </XStack>
  );
}

/** Scrollable log block with timestamp/service/message coloring */
function LogBlock({ lines, label }: { lines: string[]; label?: string }) {
  const c = useDockerColors();
  // Detect lines that look like errors
  const isErrLine = (l: string) =>
    /error|fail|exception|fatal|panic/i.test(l);

  // Try to split "TIMESTAMP SERVICE MESSAGE" format
  const parseLine = (line: string): { ts?: string; svc?: string; msg: string; isErr: boolean } => {
    // ISO timestamp at start: "2026-04-25T18:40:01Z web Server listening…"
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(\S+)\s+(.*)$/);
    if (m) return { ts: m[1], svc: m[2], msg: m[3], isErr: isErrLine(m[3]) };
    return { msg: line, isErr: isErrLine(line) };
  };

  return (
    <YStack>
      {label && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono" marginBottom={4}>{label}</Text>
      )}
      <ScrollView
        style={{ maxHeight: 140, backgroundColor: c.bgInner, borderRadius: 6 }}
        contentContainerStyle={{ padding: 8 }}
        showsVerticalScrollIndicator={false}
      >
        {lines.slice(-50).map((line, idx) => {
          const { ts, svc, msg, isErr } = parseLine(line);
          return (
            <XStack key={idx} flexWrap="wrap">
              {ts && <Text color={c.logTs} fontSize={9} fontFamily="$mono">{ts} </Text>}
              {svc && <Text color={c.logSvc} fontSize={9} fontFamily="$mono">{svc} </Text>}
              <Text color={isErr ? c.logErr : c.logMsg} fontSize={9} fontFamily="$mono" flexShrink={1}>
                {msg}
              </Text>
            </XStack>
          );
        })}
      </ScrollView>
    </YStack>
  );
}

/** Exec stdout + stderr output blocks */
function ExecOutputBlock({ stdout, stderr }: { stdout?: string; stderr?: string }) {
  const c = useDockerColors();
  return (
    <YStack gap={4}>
      {stdout && stdout.trim() && (
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
          <Text color={c.text3} fontSize={9} fontFamily="$mono" marginBottom={4}>stdout</Text>
          <Text color={c.logMsg} fontSize={9} fontFamily="$mono" lineHeight={14}>{stdout.trim()}</Text>
        </YStack>
      )}
      {stderr && stderr.trim() && (
        <YStack backgroundColor={c.bgInner} borderRadius={6} padding={8} paddingHorizontal={10}>
          <Text color={c.text3} fontSize={9} fontFamily="$mono" marginBottom={4}>stderr</Text>
          <Text color={c.logErr} fontSize={9} fontFamily="$mono" lineHeight={14}>{stderr.trim()}</Text>
        </YStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function DockerEnvRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);

  const subProps: SubRendererProps = { ...props };

  switch (shortName) {
    case 'env-create':  return <EnvCreateRenderer  {...subProps} />;
    case 'env-status':  return <EnvStatusRenderer  {...subProps} />;
    case 'env-exec':    return <EnvExecRenderer    {...subProps} />;
    case 'env-logs':    return <EnvLogsRenderer    {...subProps} />;
    case 'env-list':    return <EnvListRenderer    {...subProps} />;
    case 'env-restart': return <EnvRestartRenderer {...subProps} />;
    case 'env-destroy': return <EnvDestroyRenderer {...subProps} />;
    default:            return <DefaultDockerRenderer {...subProps} />;
  }
}


// ============================================================================
// ToolShell — compose-only adapter over <ToolCallCard>
// ============================================================================
//
// Sub-renderers feed `headerProps` from their existing computation; this
// shell hands status/description/badge to the canonical primitive. The
// `duration`/`expanded`/`onToggle` keys are silently ignored (the primitive
// owns its own state).

interface ToolShellHeaderProps {
  dotStatus: DotStatus;
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeVariant };
  activeLabel?: string;
  activeLabelColor?: string;
  expanded?: boolean;
  onToggle?: () => void;
  isInContainer?: boolean;
  irreversible?: boolean;
}

// Map DockerEnv DotStatus (incl. "creating") → ToolCallCard McaStatusType.
function dotToMcaStatus(d: DotStatus): 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission' {
  if (d === 'creating') return 'running';
  return d;
}

function ToolShell({
  dotStatus,
  description,
  badge,
  irreversible,
  children,
}: ToolShellHeaderProps & { children?: React.ReactNode }) {
  return (
    <ToolCallCard
      status={dotToMcaStatus(dotStatus)}
      description={description}
      iconUri={DOCKER_ICON}
      badge={badge ? <Badge text={badge.text} variant={badge.variant} /> : null}
      irreversible={irreversible}
    >
      {children}
    </ToolCallCard>
  );
}

export const DockerEnvToolCallRenderer = withPermissionSupport(DockerEnvRendererBase);

// Default export for dynamic import
export default DockerEnvToolCallRenderer;
