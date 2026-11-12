/**
 * Sancho Renderer — MCP meta tools.
 *
 *  - `mcp-status`     connection card: server, version, principal (id/role),
 *                     runtime; ~50 scopes as a capped pill list (not all
 *                     expanded), allowed clients/brands as chips.
 *  - `mcp-list-tools` compact tool list with the namespace as a badge and
 *                     total/matched counters.
 *  - `mcp-call`       generic escape hatch → FallbackBody (344 arbitrary
 *                     tools — a curated body adds nothing the fallback
 *                     ParamsTable + Output doesn't already say).
 */

import { CheckCircle2, XCircle } from '../../primitives';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  FallbackBody,
  formatCountBadge,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  PillList,
  ResourceCard,
  colors as globalColors,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  getToolLabel,
  narrowObject,
  parseSanchoOutput,
  pickText,
  SanchoToolShell,
  shortId,
  type SanchoMcpStatus,
  type SanchoMcpToolEntry,
  useScrollStyle,
} from './shared';

// ============================================================================
// mcp-status — connection card
// ============================================================================

const MAX_SCOPES = 12;

function statusRows(s: SanchoMcpStatus): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (s.server) rows.push({ key: 'server', value: s.server });
  if (s.version) rows.push({ key: 'version', value: s.version });
  if (s.principal?.id) rows.push({ key: 'principal', value: shortId(s.principal.id) });
  if (s.principal?.role) rows.push({ key: 'role', value: s.principal.role });
  const runtime = narrowObject<Record<string, unknown>>(s.runtime);
  if (runtime) {
    for (const k of ['name', 'version', 'node', 'uptime', 'transport'] as const) {
      const v = pickText(runtime, [k]);
      if (v) rows.push({ key: `runtime ${k}`, value: v });
    }
  }
  return rows;
}

export function McpStatusRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = parseSanchoOutput<SanchoMcpStatus>(output);
  const s = narrowObject<SanchoMcpStatus>(parsed);
  const ok = s?.ok !== false && !error;
  const accent = ok ? globalColors.green : globalColors.red;
  const scopes = Array.isArray(s?.principal?.scopes) ? s.principal.scopes : [];
  const clients = Array.isArray(s?.principal?.clients) ? s.principal.clients : [];
  const brands = Array.isArray(s?.principal?.brands) ? s.principal.brands : [];

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description="MCP server status"
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && s && (
        <ResourceCard
          leading={
            <IconTile
              accent={accent}
              icon={
                ok ? (
                  <CheckCircle2 size={16} color={accent} />
                ) : (
                  <XCircle size={16} color={accent} />
                )
              }
              size={28}
            />
          }
          title={ok ? 'Sancho MCP server' : 'Connection failed'}
          subtitle={s.server ? `${s.server}${s.version ? ` · v${s.version}` : ''}` : undefined}
          meta={<IconChip text={ok ? 'CONNECTED' : 'NOT CONNECTED'} accent={accent} />}
        >
          <KeyValueGrid rows={statusRows(s)} />
          {scopes.length > 0 && (
            <YStack gap={4}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                scopes ({scopes.length})
              </Text>
              <PillList
                items={scopes.slice(0, MAX_SCOPES)}
                max={MAX_SCOPES}
                accent={c.accent}
              />
              {scopes.length > MAX_SCOPES && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  +{scopes.length - MAX_SCOPES} more scopes
                </Text>
              )}
            </YStack>
          )}
          {(clients.length > 0 || brands.length > 0) && (
            <YStack gap={4}>
              {clients.length > 0 && (
                <XStack gap={4} flexWrap="wrap" alignItems="center">
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                    clients
                  </Text>
                  {clients.map((cl) => (
                    <IconChip key={cl} text={cl} accent={globalColors.violet} />
                  ))}
                </XStack>
              )}
              {brands.length > 0 && (
                <XStack gap={4} flexWrap="wrap" alignItems="center">
                  <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                    brands
                  </Text>
                  {brands.map((b) => (
                    <IconChip key={b} text={b} accent={globalColors.violet} />
                  ))}
                </XStack>
              )}
            </YStack>
          )}
        </ResourceCard>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// mcp-list-tools — compact list, namespace badge, total/matched counters
// ============================================================================

/** `alarife_list_instances` → `alarife`; bare names get `sancho`. */
function namespaceOf(name: string): string {
  const ns = name.includes('_') ? name.split('_')[0] : '';
  return ns || 'sancho';
}

const MAX_TOOLS = 50;

export function McpListToolsRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(320);
  const parsed = parseSanchoOutput<Record<string, unknown>>(output);
  const data = narrowObject<Record<string, unknown>>(parsed);
  const tools = Array.isArray(data?.tools) ? (data.tools as SanchoMcpToolEntry[]) : [];
  const matched = typeof data?.matched === 'number' ? data.matched : tools.length;
  const total = typeof data?.total === 'number' ? data.total : undefined;
  const namespace = typeof input?.namespace === 'string' ? input.namespace : undefined;

  const description = namespace
    ? `MCP tools (${namespace})`
    : total != null
      ? `MCP tools (${total} available)`
      : 'MCP tools';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
      badge={
        status === 'completed' ? (
          <Badge
            text={formatCountBadge(matched, 'tool')}
            variant={countBadgeVariant(matched)}
          />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {tools.length === 0 ? (
            <Empty message="No tools matched" hint="Try another namespace or clear the filter." />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {tools.slice(0, MAX_TOOLS).map((t) => (
                  <EntityRow
                    key={t.name}
                    leading={<IconChip text={namespaceOf(t.name)} accent={c.accent} />}
                    title={t.name}
                    subtitle={t.description}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(total != null || matched > tools.length) && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              {matched > tools.length && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  showing {tools.length} of {matched}
                </Text>
              )}
              {total != null && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  · {total} on the server
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// mcp-call — generic escape hatch → FallbackBody (brand card keeps identity)
// ============================================================================

export function McpCallRenderer(props: ToolCallRendererProps) {
  const tool = typeof props.input?.tool === 'string' ? props.input.tool : undefined;
  return (
    <SanchoToolShell
      toolName={props.toolName}
      status={props.status}
      description={tool ? `MCP call · ${tool}` : getToolLabel(props.toolName)}
    >
      <FallbackBody
        status={props.status}
        input={props.input}
        output={props.output}
        error={props.error}
        attachments={props.attachments}
      />
    </SanchoToolShell>
  );
}
