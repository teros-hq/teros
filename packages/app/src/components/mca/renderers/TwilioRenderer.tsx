/**
 * Twilio MCA — Custom Tool Call Renderer (`mca.twilio`)
 *
 * One sub-renderer per tool, keyed by the REAL tool names of
 * `mcas/mca.twilio/tools.json`. Output shapes verified against
 * `mcas/mca.twilio/src/index.ts` (2026-10-19):
 *   -health-check · get-account · list-phone-numbers · list-available-numbers
 *   buy-phone-number · send-sms · list-messages · list-calls · get-call
 *
 * Editorial style: Specsheet for single entities, EntityRow-style rows for
 * lists (capped at LIST_CAP + pagination footer), Badge for statuses.
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, Specsheet, ToolCallCard, parseOutput, useColors } from '../primitives';
import { getShortToolName } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

const LIST_CAP = 10;

interface SmsMessage {
  sid?: string; to?: string; from?: string; body?: string; status?: string;
  direction?: string; price?: string | null; price_unit?: string | null;
  date_sent?: string | null; date_created?: string; num_segments?: number;
  error_code?: number | null; error_message?: string | null;
}

interface CallRecord {
  sid?: string; to?: string; from?: string; status?: string; direction?: string;
  duration?: number | null; start_time?: string; end_time?: string;
  price?: string | null; price_unit?: string | null; answered_by?: string | null;
}

function statusVariant(s?: string | null): 'success' | 'error' | 'warning' | 'info' | 'gray' {
  switch (s) {
    case 'delivered': case 'queued': case 'received': case 'sent':
    case 'completed': case 'in-progress': case 'active': case 'ready':
      return 'success';
    case 'failed': case 'undelivered': case 'busy': case 'no-answer': case 'canceled':
      return 'error';
    case 'scheduled': case 'ringing': case 'pending':
      return 'warning';
    default: return 'gray';
  }
}

function fmtDurationSecs(s?: number | null): string {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtPrice(price?: string | null, unit?: string | null): string {
  if (price === null || price === undefined || price === '') return '—';
  return `${price} ${unit ?? ''}`.trim();
}

function asObject(output?: string): Record<string, any> | null {
  const parsed = output ? parseOutput<Record<string, any>>(output) : null;
  return typeof parsed === 'object' && parsed !== null ? parsed : null;
}

function errBlock(error?: string, status?: string, output?: string) {
  const e = error || (status === 'failed' ? output : null);
  return e ? <ErrorBlock error={e} /> : null;
}

// ============================================================ health-check
function HealthCheckRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const hs = (d?.status as string) || 'unknown';
  const variant = hs === 'ready' ? 'success' : hs === 'degraded' ? 'warning' : hs === 'not_ready' ? 'error' : 'gray';
  const issues = Array.isArray(d?.issues) ? d.issues : [];
  return (
    <ToolCallCard status={status} description="Twilio health check" iconUri={appIcon}
      badge={status === 'completed' ? <Badge text={hs} variant={variant} /> : null}>
      {errBlock(error, status, output)}
      {d && (
        <Specsheet sections={[
          { title: 'Diagnostics', rows: [
            { key: 'status', value: hs },
            { key: 'version', value: (d.version as string) || '?' },
            { key: 'uptime', value: typeof d.uptime === 'number' ? `${d.uptime}s` : '—' },
            ...(issues.length ? [{ key: 'issues', value: String(issues.length) }] : []),
          ] },
        ] } />
      )}
    </ToolCallCard>
  );
}

// ============================================================ get-account
function GetAccountRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const bal = d?.balance as { amount?: number; currency?: string } | undefined;
  return (
    <ToolCallCard status={status} description="Account info" iconUri={appIcon}
      badge={d?.status ? <Badge text={String(d.status)} variant={statusVariant(String(d.status))} /> : null}>
      {errBlock(error, status, output)}
      {d && (
        <Specsheet sections={[
          { title: 'Account', rows: [
            { key: 'name', value: (d.friendly_name as string) ?? '—' },
            { key: 'sid', value: (d.account_sid as string) ?? '—' },
            { key: 'type', value: (d.type as string) ?? '—' },
            { key: 'created', value: (d.date_created as string) ?? '—' },
          ] },
          { title: 'Balance', rows: [
            { key: 'amount', value: bal?.amount !== undefined ? `${bal.amount} ${bal.currency ?? ''}`.trim() : '—' },
          ] },
        ] } />
      )}
    </ToolCallCard>
  );
}

// ============================================================ send-sms
function SendSmsRenderer({ status, output, error, appIcon, input }: ToolCallRendererProps) {
  const d = asObject(output);
  const to = (d?.to as string) || input?.to || '';
  const body = (d?.body as string) || input?.body || '';
  return (
    <ToolCallCard status={status} description={to ? `Send SMS to ${to}` : 'Send SMS'} iconUri={appIcon}
      badge={d?.status ? <Badge text={String(d.status)} variant={statusVariant(String(d.status))} /> : null}>
      {errBlock(error, status, output)}
      {d && (
        <YStack gap={6}>
          <XStack gap={6} alignItems="center" flexWrap="wrap">
            <Text fontSize={10} color="$text3">from</Text>
            <Text fontSize={12} color="$text2">{(d.from as string) ?? (input?.fromNumber as string) ?? '—'}</Text>
            {d.direction ? <Badge text={String(d.direction)} variant="gray" /> : null}
          </XStack>
          <Text fontSize={12} color="$text" numberOfLines={4}>{body}</Text>
          <Specsheet sections={[
            { title: 'Delivery', rows: [
              { key: 'sid', value: (d.message_sid as string) ?? '—' },
              { key: 'status', value: (d.status as string) ?? '—' },
              { key: 'price', value: fmtPrice(d.price as string, d.price_unit as string) },
              { key: 'created', value: (d.date_created as string) ?? '—' },
            ] },
          ] } />
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================ list-messages
function ListMessagesRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const d = asObject(output);
  const msgs = (d?.messages as SmsMessage[]) ?? [];
  const shown = msgs.slice(0, LIST_CAP);
  return (
    <ToolCallCard status={status} description={d ? `Messages (${d.total ?? msgs.length})` : 'Messages'} iconUri={appIcon}
      badge={status === 'completed' && d ? <Badge text={`${d.total ?? msgs.length}`} variant="info" /> : null}>
      {errBlock(error, status, output)}
      {shown.length > 0 && (
        <YStack gap={8}>
          {shown.map((m, i) => (
            <YStack key={m.sid ?? i} gap={3} paddingBottom={8} borderBottomWidth={i < shown.length - 1 ? 1 : 0} borderColor="$border">
              <XStack gap={6} alignItems="center" flexWrap="wrap">
                <Text fontSize={11} color="$text2">{m.from ?? '—'} → {m.to ?? '—'}</Text>
                {m.status ? <Badge text={m.status} variant={statusVariant(m.status)} /> : null}
                {m.direction ? <Badge text={m.direction} variant="gray" /> : null}
              </XStack>
              {m.body ? <Text fontSize={11} color="$text3" numberOfLines={2}>{m.body}</Text> : null}
              <XStack gap={10} alignItems="center">
                {m.date_sent ? <Text fontSize={9} color="$text3">{String(m.date_sent).replace('T', ' ').substring(0, 16)}</Text> : null}
                {m.price ? <Text fontSize={9} color="$text3">{fmtPrice(m.price, m.price_unit)}</Text> : null}
                {m.num_segments ? <Text fontSize={9} color="$text3">{m.num_segments} seg</Text> : null}
                {m.error_message ? <Text fontSize={9} color="$text3">⚠ {m.error_message}</Text> : null}
              </XStack>
            </YStack>
          ))}
          {msgs.length > LIST_CAP && (
            <Text fontSize={10} color="$text3">+ {msgs.length - LIST_CAP} more…</Text>
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================ list-calls / get-call
function CallSpec({ call }: { call: CallRecord }) {
  return (
    <Specsheet sections={[
      { title: 'Call', rows: [
        { key: 'to', value: call.to ?? '—' },
        { key: 'from', value: call.from ?? '—' },
        { key: 'status', value: call.status ?? '—' },
        { key: 'direction', value: call.direction ?? '—' },
      ] },
      { title: 'Timeline & cost', rows: [
        { key: 'start', value: call.start_time ?? '—' },
        { key: 'end', value: call.end_time ?? '—' },
        { key: 'duration', value: fmtDurationSecs(call.duration) },
        { key: 'price', value: fmtPrice(call.price, call.price_unit) },
      ] },
    ] } />
  );
}

function ListCallsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const calls = (d?.calls as CallRecord[]) ?? [];
  const shown = calls.slice(0, LIST_CAP);
  return (
    <ToolCallCard status={status} description={d ? `Calls (${d.total ?? calls.length})` : 'Calls'} iconUri={appIcon}
      badge={status === 'completed' && d ? <Badge text={`${d.total ?? calls.length}`} variant="info" /> : null}>
      {errBlock(error, status, output)}
      {shown.length > 0 && (
        <YStack gap={8}>
          {shown.map((cl, i) => (
            <YStack key={cl.sid ?? i} gap={3} paddingBottom={8} borderBottomWidth={i < shown.length - 1 ? 1 : 0} borderColor="$border">
              <XStack gap={6} alignItems="center" flexWrap="wrap">
                <Text fontSize={11} color="$text2">{cl.from ?? '—'} → {cl.to ?? '—'}</Text>
                {cl.status ? <Badge text={cl.status} variant={statusVariant(cl.status)} /> : null}
              </XStack>
              <XStack gap={10} alignItems="center">
                {cl.start_time ? <Text fontSize={9} color="$text3">{String(cl.start_time).replace('T', ' ').substring(0, 16)}</Text> : null}
                {cl.duration !== null && cl.duration !== undefined ? <Text fontSize={9} color="$text3">{fmtDurationSecs(cl.duration)}</Text> : null}
                {cl.price ? <Text fontSize={9} color="$text3">{fmtPrice(cl.price, cl.price_unit)}</Text> : null}
              </XStack>
            </YStack>
          ))}
          {calls.length > LIST_CAP && <Text fontSize={10} color="$text3">+ {calls.length - LIST_CAP} more…</Text>}
        </YStack>
      )}
    </ToolCallCard>
  );
}

function GetCallRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const recordings = (d?.recordings as any[]) ?? [];
  return (
    <ToolCallCard status={status} description="Call detail" iconUri={appIcon}
      badge={d?.status ? <Badge text={String(d.status)} variant={statusVariant(String(d.status))} /> : null}>
      {errBlock(error, status, output)}
      {d && (
        <YStack gap={6}>
          <CallSpec call={d as CallRecord} />
          {recordings.length > 0 && (
            <Specsheet sections={[
              { title: 'Recordings', rows: recordings.map((r, i) => ({
                key: r.sid ?? `rec-${i}`, value: `${r.duration ?? '?'}s · ${r.status ?? '?'}`,
              })) },
            ] } />
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================ numbers
function CapsBadges({ caps }: { caps?: Record<string, boolean> }) {
  if (!caps) return null;
  const on = (Object.keys(caps) as Array<keyof typeof caps>).filter((k) => caps[k]);
  if (on.length === 0) return null;
  return <XStack gap={4} flexWrap="wrap">{on.map((k) => <Badge key={String(k)} text={String(k)} variant="gray" />)}</XStack>;
}

function ListPhoneNumbersRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const nums = (d?.phone_numbers as any[]) ?? [];
  return (
    <ToolCallCard status={status} description={d ? `Phone numbers (${d.total ?? nums.length})` : 'Phone numbers'} iconUri={appIcon}
      badge={status === 'completed' && d ? <Badge text={`${d.total ?? nums.length}`} variant="info" /> : null}>
      {errBlock(error, status, output)}
      {nums.length > 0 && (
        <YStack gap={8}>
          {nums.slice(0, LIST_CAP).map((n, i) => (
            <YStack key={n.sid ?? i} gap={3} paddingBottom={8} borderBottomWidth={i < Math.min(nums.length, LIST_CAP) - 1 ? 1 : 0} borderColor="$border">
              <XStack gap={6} alignItems="center" flexWrap="wrap">
                <Text fontSize={12} color="$text">{n.phone_number ?? '—'}</Text>
                {n.status ? <Badge text={String(n.status)} variant={statusVariant(String(n.status))} /> : null}
              </XStack>
              {n.friendly_name ? <Text fontSize={10} color="$text3">{String(n.friendly_name)}</Text> : null}
              <CapsBadges caps={n.capabilities} />
            </YStack>
          ))}
          {nums.length > LIST_CAP && <Text fontSize={10} color="$text3">+ {nums.length - LIST_CAP} more…</Text>}
        </YStack>
      )}
    </ToolCallCard>
  );
}

function ListAvailableNumbersRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  const nums = (d?.available_numbers as any[]) ?? [];
  return (
    <ToolCallCard status={status} description={d ? `Available in ${(d.country as string) ?? '?'} (${d.total ?? nums.length})` : 'Available numbers'} iconUri={appIcon}
      badge={status === 'completed' && d ? <Badge text={`${d.total ?? nums.length}`} variant="info" /> : null}>
      {errBlock(error, status, output)}
      {nums.length > 0 && (
        <YStack gap={8}>
          {nums.slice(0, LIST_CAP).map((n, i) => (
            <YStack key={(n.phone_number as string) ?? i} gap={3} paddingBottom={8} borderBottomWidth={i < Math.min(nums.length, LIST_CAP) - 1 ? 1 : 0} borderColor="$border">
              <Text fontSize={12} color="$text">{n.phone_number ?? '—'}</Text>
              {(n.locality || n.region) ? <Text fontSize={10} color="$text3">{[n.locality, n.region, n.iso_country].filter(Boolean).join(', ')}</Text> : null}
              <CapsBadges caps={n.capabilities} />
            </YStack>
          ))}
          {nums.length > LIST_CAP && <Text fontSize={10} color="$text3">+ {nums.length - LIST_CAP} more…</Text>}
        </YStack>
      )}
    </ToolCallCard>
  );
}

function BuyPhoneNumberRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const d = asObject(output);
  return (
    <ToolCallCard status={status} description={d?.phone_number ? `Bought ${d.phone_number}` : 'Buy phone number'} iconUri={appIcon}
      badge={status === 'completed' ? <Badge text="bought" variant="success" /> : null}>
      {errBlock(error, status, output)}
      {d && (
        <YStack gap={6}>
          <XStack gap={6} alignItems="center" flexWrap="wrap">
            <Text fontSize={13} color="$text">{d.phone_number ?? '—'}</Text>
            {d.friendly_name ? <Text fontSize={10} color="$text3">{String(d.friendly_name)}</Text> : null}
          </XStack>
          <CapsBadges caps={d.capabilities} />
          <Specsheet sections={[
            { title: 'Registration', rows: [
              { key: 'sid', value: (d.sid as string) ?? '—' },
              { key: 'created', value: (d.date_created as string) ?? '—' },
            ] },
          ] } />
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================ dispatcher
const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  'get-account': GetAccountRenderer,
  'list-phone-numbers': ListPhoneNumbersRenderer,
  'list-available-numbers': ListAvailableNumbersRenderer,
  'buy-phone-number': BuyPhoneNumberRenderer,
  'send-sms': SendSmsRenderer,
  'list-messages': ListMessagesRenderer,
  'list-calls': ListCallsRenderer,
  'get-call': GetCallRenderer,
};

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);
  let badge: React.ReactNode = null;
  if (status === 'completed') badge = <Badge text="done" variant="success" />;
  else if (status === 'failed') badge = <Badge text="failed" variant="error" />;
  return (
    <ToolCallCard status={status} description={shortName.replace(/-/g, ' ')} badge={badge} iconUri={appIcon} />
  );
}

function TwilioRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const TwilioToolCallRenderer = withPermissionSupport(TwilioRendererBase);
export default TwilioToolCallRenderer;
