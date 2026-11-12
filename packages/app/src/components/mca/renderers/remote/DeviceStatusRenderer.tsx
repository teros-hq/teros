/**
 * Device Status Renderer — `mca.teros.remote:device-status`.
 *
 * Spec REQ-6 / REQ-13: online/offline, uptime, version, allowed roots,
 * bash enabled, last tunnel error. Editorial Specsheet: Identity / Tunnel /
 * Scope / Diagnostics. Online badge when the tunnel is up.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, Specsheet, ToolCallCard, parseOutput, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

interface DeviceStatusOutput {
  status?: string;
  tunnelState?: string;
  deviceId?: string;
  daemonVersion?: string;
  uptimeSeconds?: number;
  connectedSince?: string | null;
  hostname?: string;
  os?: string;
  arch?: string;
  user?: string;
  allowedRoots?: string[];
  execEnabled?: boolean;
  searchEngine?: string;
  inFlight?: number;
  totalCalls?: number;
  reconnects?: number;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

function fmtUptime(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

export function DeviceStatusRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = output ? parseOutput<DeviceStatusOutput>(output) : null;
  const d = typeof data === 'object' && data !== null ? data : null;

  const online = d?.status === 'online';
  const badge =
    status === 'failed' ? <Badge text="failed" variant="error" />
    : d ? <Badge text={online ? 'online' : (d.status ?? 'offline')} variant={online ? 'success' : 'gray'} />
    : null;

  return (
    <ToolCallCard
      status={status}
      description={d?.hostname ? `Device status — ${d.hostname}` : 'Device status'}
      iconUri={appIcon}
      badge={badge}
    >
      {error ? <ErrorBlock error={error} /> : null}
      {d && (
        <Specsheet
          sections={[
            {
              title: 'Identity',
              rows: [
                { key: 'hostname', value: d.hostname ?? '—' },
                { key: 'user', value: d.user ?? '—' },
                { key: 'os', value: `${d.os ?? '?'} · ${d.arch ?? '?'}` },
                { key: 'daemon', value: d.daemonVersion ?? '—' },
              ],
            },
            {
              title: 'Tunnel',
              rows: [
                { key: 'state', value: d.tunnelState ?? d.status ?? '—' },
                { key: 'uptime', value: fmtUptime(d.uptimeSeconds) },
                { key: 'connected since', value: d.connectedSince ?? '—' },
                { key: 'calls', value: `${d.totalCalls ?? 0} total · ${d.reconnects ?? 0} reconnects` },
              ],
            },
            {
              title: 'Scope',
              rows: [
                { key: 'roots', value: (d.allowedRoots ?? []).join(', ') || '—' },
                { key: 'bash', value: d.execEnabled ? 'enabled' : 'disabled' },
                { key: 'search', value: d.searchEngine ?? '—' },
              ],
            },
            ...(d.lastError
              ? [{ title: 'Last error', rows: [
                  { key: 'at', value: d.lastErrorAt ?? '—' },
                  { key: 'error', value: d.lastError },
                ] }]
              : []),
          ]}
        />
      )}
    </ToolCallCard>
  );
}
