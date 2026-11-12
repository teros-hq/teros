/**
 * Get Info Renderer — `mca.teros.remote:get-info` (T-REM-3).
 *
 * System snapshot of the paired machine in six blocks: identity / system /
 * network / hardware / battery / scope. Editorial Specsheet, one section per
 * block, values that can be long (kernel, IPs) kept mono-friendly.
 */

import type React from 'react';
import { Badge, ErrorBlock, Specsheet, ToolCallCard, parseOutput } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

interface GetInfoOutput {
  identity?: { name?: string; hostname?: string; deviceId?: string | null; daemonVersion?: string };
  system?: { os?: string; arch?: string; kernelVersion?: string; systemUptimeSeconds?: number; bootTimeISO?: string };
  network?: { localIPs?: Array<{ interface: string; ip: string }>; externalIP?: string | null };
  hardware?: { cpu?: { model?: string; cores?: number }; memory?: { totalBytes?: number; freeBytes?: number }; rootDisk?: { totalBytes?: number; freeBytes?: number } };
  battery?: { present: boolean; percent?: number | null; charging?: boolean | null } | null;
  scope?: { allowedRoots?: string[]; execEnabled?: boolean };
}

function fmtBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function GetInfoRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? parseOutput<GetInfoOutput>(output) : null;
  const d = typeof data === 'object' && data !== null ? data : null;

  const badge =
    status === 'failed' ? <Badge text="failed" variant="error" />
    : d?.identity?.name ? <Badge text={d.identity.name} variant="info" />
    : null;

  return (
    <ToolCallCard
      status={status}
      description={d?.identity?.hostname ? `System info — ${d.identity.hostname}` : 'System info'}
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
                { key: 'name', value: d.identity?.name ?? '—' },
                { key: 'hostname', value: d.identity?.hostname ?? '—' },
                { key: 'daemon', value: d.identity?.daemonVersion ?? '—' },
              ],
            },
            {
              title: 'System',
              rows: [
                { key: 'os', value: `${d.system?.os ?? '?'} · ${d.system?.arch ?? '?'}` },
                { key: 'kernel', value: d.system?.kernelVersion ?? '—' },
                { key: 'uptime', value: fmtUptime(d.system?.systemUptimeSeconds) },
                { key: 'boot', value: d.system?.bootTimeISO ?? '—' },
              ],
            },
            {
              title: 'Network',
              rows: [
                { key: 'local', value: (d.network?.localIPs ?? []).map((x) => `${x.interface}: ${x.ip}`).join('  ·  ') || '—' },
                { key: 'external', value: d.network?.externalIP ?? '—' },
              ],
            },
            {
              title: 'Hardware',
              rows: [
                { key: 'cpu', value: d.hardware?.cpu?.model ? `${d.hardware.cpu.model} (${d.hardware.cpu.cores ?? '?'} cores)` : '—' },
                { key: 'memory', value: d.hardware?.memory ? `${fmtBytes(d.hardware.memory.freeBytes)} free / ${fmtBytes(d.hardware.memory.totalBytes)}` : '—' },
                { key: 'disk', value: d.hardware?.rootDisk ? `${fmtBytes(d.hardware.rootDisk.freeBytes)} free / ${fmtBytes(d.hardware.rootDisk.totalBytes)}` : '—' },
              ],
            },
            ...(d.battery?.present
              ? [{ title: 'Battery', rows: [
                  { key: 'charge', value: d.battery.percent !== null && d.battery.percent !== undefined ? `${d.battery.percent}%` : '—' },
                  { key: 'state', value: d.battery.charging === true ? 'charging' : d.battery.charging === false ? 'discharging' : '—' },
                ] }]
              : []),
            {
              title: 'Scope',
              rows: [
                { key: 'roots', value: (d.scope?.allowedRoots ?? []).join(', ') || '—' },
                { key: 'bash', value: d.scope?.execEnabled ? 'enabled' : 'disabled' },
              ],
            },
          ]}
        />
      )}
    </ToolCallCard>
  );
}
