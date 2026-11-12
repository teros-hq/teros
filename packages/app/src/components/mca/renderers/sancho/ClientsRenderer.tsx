/**
 * Sancho Renderer — client tools.
 *
 *  - `list-clients`       rows: name + slug, Mission Control as an external
 *                          link chip.
 *  - `get-client-context` the richest tool — a compact hierarchical
 *                          dashboard, NOT a JSON dump: summary, active work
 *                          (status badges), projects with task counts,
 *                          blockers with severity, next steps, metrics and
 *                          freshness. Sections only render when the server
 *                          populated them.
 */

import { ExternalLink } from '../../primitives';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  formatDate,
  narrowObject,
  parseSanchoOutput,
  pickArray,
  pickText,
  scalarText,
  SanchoToolShell,
  severityChipProps,
  taskStatusChipProps,
  truncate,
  unwrapList,
  useScrollStyle,
  type SanchoClient,
} from './shared';

// ============================================================================
// list-clients — rows with slug + Mission Control link
// ============================================================================

export function ListClientsRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(280);
  const parsed = parseSanchoOutput<unknown>(output);
  const { items: clients } = unwrapList<SanchoClient>(parsed, 'clients');

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description="Clients"
      badge={
        status === 'completed' ? (
          <Badge
            text={formatCountBadge(clients.length, 'client')}
            variant={countBadgeVariant(clients.length)}
          />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {clients.length === 0 ? (
            <Empty message="No clients" hint="The MCP token does not allow any client." />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {clients.map((cl) => (
                  <EntityRow
                    key={cl.slug}
                    leading={<IconTile label={cl.slug} size={24} />}
                    title={cl.name ?? cl.slug}
                    subtitle={cl.name ? cl.slug : undefined}
                    trailing={
                      cl.missionControlUrl ? (
                        <XStack
                          onPress={() => {
                            if (cl.missionControlUrl) void Linking.openURL(cl.missionControlUrl);
                          }}
                          cursor="pointer"
                          gap={4}
                          alignItems="center"
                        >
                          <IconChip
                            text="Mission Control"
                            accent={c.accent}
                            icon={<ExternalLink size={9} color={c.accent} />}
                          />
                        </XStack>
                      ) : undefined
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// get-client-context — compact hierarchical dashboard
// ============================================================================

interface ActiveWorkItem {
  id?: string;
  title?: string;
  name?: string;
  status?: string;
  owner?: string;
  updated_at?: string;
}

interface ProjectItem {
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  task_counts?: Record<string, number>;
  tasks?: Record<string, number>;
}

interface BlockerItem {
  id?: string;
  title?: string;
  description?: string;
  severity?: string;
  reason?: string;
}

interface NextStepItem {
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  status?: string;
}

/** Section header — mono uppercase label with a count. */
function SectionLabel({ label, count }: { label: string; count?: number }) {
  const c = useColors();
  // Single template string — separate expressions render as separate text
  // nodes in RNW, which breaks the text in the DOM (and any getByText match).
  // Uppercased literally: textTransform is visual-only, the DOM text must
  // carry the casing itself.
  const text = (count != null ? `${label} (${count})` : label).toUpperCase();
  return (
    <Text color={c.text3} fontSize={9} fontFamily="$mono">
      {text}
    </Text>
  );
}

function activeWorkRow(w: ActiveWorkItem, i: number) {
  const chip = taskStatusChipProps(w.status);
  return (
    <EntityRow
      // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered list
      key={w.id ?? i}
      title={w.title ?? w.name ?? w.id ?? 'Untitled'}
      subtitle={w.owner ? `${w.owner}${w.updated_at ? ` · ${formatDate(w.updated_at) ?? ''}` : ''}` : undefined}
      badges={<Badge text={chip.text} variant={chip.variant} />}
    />
  );
}

function projectRow(p: ProjectItem, i: number) {
  const c = useColors();
  const counts = p.task_counts ?? p.tasks;
  const open =
    counts && typeof counts.open === 'number' ? counts.open : undefined;
  const done =
    counts && typeof counts.done === 'number' ? counts.done : undefined;
  const total = counts
    ? Object.entries(counts).reduce((acc, [, v]) => acc + (typeof v === 'number' ? v : 0), 0)
    : undefined;
  return (
    <EntityRow
      // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered list
      key={p.id ?? i}
      title={p.name ?? p.title ?? p.id ?? 'Project'}
      subtitle={p.id}
      meta={
        total != null ? (
          <XStack gap={4} alignItems="center">
            {open != null && open > 0 && <IconChip text={`${open} open`} accent={c.accent} />}
            {done != null && done > 0 && <IconChip text={`${done} done`} accent={c.accent} />}
          </XStack>
        ) : undefined
      }
    />
  );
}

function blockerRow(b: BlockerItem, i: number) {
  const sev = severityChipProps(b.severity);
  return (
    <YStack
      // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered list
      key={b.id ?? i}
      gap={4}
      padding={8}
      borderRadius={5}
      backgroundColor="rgba(239,68,68,0.08)"
      borderWidth={1}
      borderColor="rgba(239,68,68,0.25)"
    >
      <XStack gap={6} alignItems="center" flexWrap="wrap">
        <Text fontSize={10}>{b.title ?? b.description ?? 'Blocker'}</Text>
        {sev && <Badge text={sev.text} variant={sev.variant} />}
      </XStack>
      {b.reason && (
        <Text fontSize={9} opacity={0.7}>
          {truncate(b.reason, 160)}
        </Text>
      )}
    </YStack>
  );
}

function nextStepRow(n: NextStepItem, i: number) {
  const chip = taskStatusChipProps(n.status);
  return (
    <EntityRow
      // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered list
      key={n.id ?? i}
      title={n.title ?? n.name ?? n.description ?? 'Next step'}
      badges={n.status ? <Badge text={chip.text} variant={chip.variant} /> : undefined}
    />
  );
}

function contextRows(o: Record<string, unknown>): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const status = pickText(o, ['status']);
  if (status) rows.push({ key: 'status', value: status });
  const metrics = narrowObject<Record<string, unknown>>(o.metrics);
  if (metrics) {
    for (const [k, v] of Object.entries(metrics).slice(0, 6)) {
      const t = scalarText(v);
      if (t) rows.push({ key: k, value: t });
    }
  }
  return rows;
}

const MAX_ITEMS_PER_SECTION = 8;

export function GetClientContextRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(200);
  const slug = typeof input?.clientSlug === 'string' ? input.clientSlug : undefined;
  const parsed = parseSanchoOutput<unknown>(output);
  const o = narrowObject<Record<string, unknown>>(parsed);

  const client = narrowObject<Record<string, unknown>>(o?.client);
  const clientName = pickText(client, ['name', 'slug']) ?? slug;
  const summary = pickText(o, ['summary']);
  const activeWork = pickArray(o, ['active_work', 'activeWork']) as ActiveWorkItem[];
  const projects = pickArray(o, ['projects']) as ProjectItem[];
  const blockers = pickArray(o, ['blockers']) as BlockerItem[];
  const nextSteps = pickArray(o, ['next_steps', 'nextSteps']) as NextStepItem[];
  const freshness = narrowObject<Record<string, unknown>>(o?.freshness);

  const description = clientName ? `Client context · ${clientName}` : 'Client context';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && o && (
        <ResourceCard
          leading={<IconTile accent={c.accent} label={clientName ?? '?'} size={30} />}
          title={clientName ?? 'Client'}
          subtitle={summary ? truncate(summary, 120) : undefined}
          meta={
            <IconChip
              text={pickText(o, ['status']) ?? 'context'}
              accent={c.accent}
            />
          }
        >
          {summary && summary.length > 120 && (
            <Text color={c.text2} fontSize={10}>
              {summary}
            </Text>
          )}

          {activeWork.length > 0 && (
            <YStack gap={4}>
              <SectionLabel label="active work" count={activeWork.length} />
              <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
                <YStack>
                  {activeWork.slice(0, MAX_ITEMS_PER_SECTION).map(activeWorkRow)}
                </YStack>
              </ScrollView>
            </YStack>
          )}

          {projects.length > 0 && (
            <YStack gap={4}>
              <SectionLabel label="projects" count={projects.length} />
              <YStack>
                {projects.slice(0, MAX_ITEMS_PER_SECTION).map(projectRow)}
              </YStack>
            </YStack>
          )}

          {blockers.length > 0 && (
            <YStack gap={4}>
              <SectionLabel label="blockers" count={blockers.length} />
              <YStack gap={6}>
                {blockers.slice(0, MAX_ITEMS_PER_SECTION).map(blockerRow)}
              </YStack>
            </YStack>
          )}

          {nextSteps.length > 0 && (
            <YStack gap={4}>
              <SectionLabel label="next steps" count={nextSteps.length} />
              <YStack>
                {nextSteps.slice(0, MAX_ITEMS_PER_SECTION).map(nextStepRow)}
              </YStack>
            </YStack>
          )}

          {(contextRows(o).length > 0 || freshness) && (
            <KeyValueGrid rows={contextRows(o)} />
          )}
        </ResourceCard>
      )}
    </SanchoToolShell>
  );
}
