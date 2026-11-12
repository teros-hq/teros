/**
 * mca.teros.core — Tool Call Renderer
 *
 * Cobertura 100%: cada uno de los 43 tools del MCA Core tiene un renderer
 * dedicado que pinta los datos devueltos usando primitivos semánticos
 * (ResourceCard, DualEntity, EntityRow, KeyValueGrid, …).
 *
 * Organización del archivo:
 *   1. Tipos compartidos por dominio (Agent, Workspace, App, Skill, Provider).
 *   2. Labels y helpers (StatusBadge, formatDate, unwrap, diff, …).
 *   3. Renderers por dominio (Agents, Workspaces, Apps, Skills).
 *   4. FallbackRenderer (señal de bug: tool sin renderer).
 *   5. Registry + entry point.
 *
 * Principios:
 *   - Backend devuelve datos puros — la frase visible se compone aquí.
 *   - Un renderer por tool, sin mega-switches ni lógica inferida.
 *   - Primitivos antes que layout ad-hoc (ver primitives/ para el catálogo).
 *   - JsonPreview queda restringido a `includeRaw=true` o al fallback dev.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { getTerosClient } from '../../../services/terosClientSingleton';
import { useNavbarStore } from '../../../store/navbarStore';
import { useTilingStore } from '../../../store/tilingStore';

import {
  ActionBadge,
  Avatar,
  Badge,
  colors,
  ConfirmDialog,
  type DescriptionVars,
  useColors,
  DualEntity,
  type DualAction,
  Empty,
  EntityCard,
  EntityRow,
  ErrorBlock,
  firstName,
  getShortToolName,
  IconChip,
  IconTile,
  JsonPreview,
  KeyValueGrid,
  type KeyValueRow,
  MAX_ITEMS,
  parseOutput,
  PillList,
  ResourceCard,
  SuccessBlock,
  ToolCallCard,
  truncate,
  useToolDescription,
} from '../primitives';
import { FONT_SANS } from '../primitives/fonts';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { backendUrl } from '../../../config/runtime';

// ============================================================================
// 1. SHARED TYPES (shape del output de las tools del MCA Core)
// ============================================================================

interface Agent {
  agentId: string;
  name?: string;
  fullName?: string;
  role?: string;
  workspaceId?: string | null;
  coreId?: string;
  ownerId?: string;
  createdAt?: string;
  intro?: string;
  avatarUrl?: string;
  maxSteps?: number;
  updatedAt?: string;
  context?: string;
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  core?: { coreId: string; name?: string; fullName?: string; avatarUrl?: string };
}

interface Workspace {
  workspaceId: string;
  name?: string;
  description?: string;
  context?: string;
  ownerId?: string;
  volumeId?: string;
  members?: Array<{ userId: string; role: string; addedAt?: string }>;
  type?: 'private' | 'shared';
  status?: string;
  appearance?: { color?: string; icon?: string };
  createdAt?: string;
  updatedAt?: string;
}

interface App {
  appId: string;
  name?: string;
  mcaId?: string;
  mcaName?: string;
  ownerId?: string;
  ownerType?: string;
  status?: string;
  permissions?: Record<string, unknown>;
  createdAt?: string;
  description?: string;
  icon?: string;
  color?: string;
  category?: string;
}

interface CatalogEntry {
  mcaId: string;
  name?: string;
  description?: string;
  category?: string;
  tools?: string[];
  icon?: string;
  color?: string;
  availability?: { enabled?: boolean; hidden?: boolean; role?: string };
  auth?: { type?: string };
}

interface Provider {
  providerId?: string;
  providerType?: string;
  displayName?: string;
  name?: string;
  status?: string;
  models?: Array<string | { id: string; name?: string }>;
  isDefault?: boolean;
}

interface Skill {
  skillId: string;
  name?: string;
  description?: string;
  content?: string;
  category?: string;
  tags?: string[];
  workspaceId?: string;
  createdBy?: string;
  createdAt?: string;
  enabled?: boolean;
}

// ============================================================================
// 2. LABELS + HELPERS
// ============================================================================

/**
 * Header copy lives in i18n under `mca.tools.terosCore.<tool>` and follows
 * the description standard (primitives/tool-description.ts): one string per
 * phase, with names — never ids — and `*Generic` variants when a name is
 * unknown.
 */
const DESCRIPTION_KEY = 'mca.tools.terosCore';

function useCoreDescription(
  tool: string,
  status: ToolCallRendererProps['status'],
  vars?: DescriptionVars,
): string {
  return useToolDescription(`${DESCRIPTION_KEY}.${tool}`, status, vars);
}

/**
 * Names for the ids a tool receives, resolved from the navbar caches. They
 * cover the window before the output arrives (pending approval, running) and
 * tools whose output carries no name. Undefined when unknown — the header
 * then falls back to its generic copy, never to the raw id.
 */
function useAgentName(agentId: unknown): string | undefined {
  return useNavbarStore((s) =>
    typeof agentId === 'string' ? s.agents.find((a) => a.agentId === agentId)?.name : undefined,
  );
}

function useWorkspaceName(workspaceId: unknown): string | undefined {
  return useNavbarStore((s) =>
    typeof workspaceId === 'string'
      ? s.workspaces.find((w) => w.workspaceId === workspaceId)?.name
      : undefined,
  );
}

function useAppName(appId: unknown): string | undefined {
  return useNavbarStore((s) =>
    typeof appId === 'string' ? s.apps.find((a) => a.appId === appId)?.name : undefined,
  );
}

/**
 * Tools that cannot be undone (guide §8 — binary Irreversibility Indicator).
 * Pre-computed Set so ToolShell can derive the flag from toolName without
 * threading the bool through every sub-renderer call.
 */
const IRREVERSIBLE_TOOLS = new Set<string>([
  'delete-agent',
  'archive-workspace',
  'remove-workspace-member',
  'uninstall-app',
  'revoke-app-access',
  'skill-delete',
  'skill-revoke-access',
]);

function isIrreversibleTool(toolName: string): boolean {
  return IRREVERSIBLE_TOOLS.has(getShortToolName(toolName));
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function shortId(id: string | undefined | null, head = 10, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Extrae un objeto de shape tolerante: acepta `{ <key>: {...} }` o el objeto directo. */
function unwrap<T extends object>(
  parsed: unknown,
  wrapperKey: string,
  identifierField: keyof T,
): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const wrapped = obj[wrapperKey];
  if (wrapped && typeof wrapped === 'object' && (identifierField as string) in wrapped) {
    return wrapped as T;
  }
  if ((identifierField as string) in obj) return obj as T;
  return null;
}

function unwrapList<T extends object>(
  parsed: unknown,
  wrapperKey: string,
): { items: T[]; nextCursor?: string } {
  if (!parsed || typeof parsed !== 'object') return { items: [] };
  const obj = parsed as Record<string, unknown>;
  const list = obj[wrapperKey];
  const items = Array.isArray(list) ? (list as T[]) : [];
  const cursor = typeof obj.nextCursor === 'string' ? obj.nextCursor : undefined;
  return { items, nextCursor: cursor };
}

/**
 * Deriva una lista de pares {key, value} con los campos del input que el
 * usuario quiso cambiar. Útil para renderers de `update-*` que muestran
 * diff-like sin tener el "before" disponible.
 */
function diffFields(input: Record<string, unknown> | undefined, keys: string[]): KeyValueRow[] {
  if (!input) return [];
  const out: KeyValueRow[] = [];
  for (const k of keys) {
    const v = input[k];
    if (v !== undefined && v !== null && v !== '') {
      const str =
        typeof v === 'string' ? truncate(v, 80) : typeof v === 'object' ? '(updated)' : String(v);
      out.push({ key: k, value: str });
    }
  }
  return out;
}

function workspaceAccent(w: Pick<Workspace, 'appearance'>): string {
  const c = w.appearance?.color;
  // `purple` keeps a bespoke tone (`#a855f7`, Tailwind purple-500) — distinct
  // from the system `violet` (`#8B5CF6`) used for permission accents. Workspace
  // accents are user-visible identity, not semantic state, so we don't fold
  // them into the semantic palette.
  if (c === 'purple') return '#a855f7';
  if (c === 'green') return colors.green;
  if (c === 'red') return colors.red;
  if (c === 'amber') return colors.amber;
  return colors.indigo;
}

interface TableColumn<T> {
  key: string;
  label: string;
  width?: number | string;
  render: (row: T) => React.ReactNode;
}

function DenseTable<T>({
  rows,
  columns,
  emptyText = 'No results',
}: {
  rows: T[];
  columns: TableColumn<T>[];
  emptyText?: string;
}) {
  const c = useColors();
  if (rows.length === 0) {
    return (
      <Text color={c.text3} fontSize={10} fontFamily="$mono">
        {emptyText}
      </Text>
    );
  }

  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator
    >
      <YStack>
        <XStack
          paddingHorizontal={8}
          paddingVertical={4}
          backgroundColor={c.bgInner}
          borderBottomWidth={1}
          borderBottomColor={c.border}
        >
          {columns.map((col) => (
            <YStack key={col.key} width={col.width ?? 'auto'} flex={col.width ? undefined : 1}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                {col.label}
              </Text>
            </YStack>
          ))}
        </XStack>
        {rows.map((row, i) => (
          <XStack
            // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reorder
            key={i}
            paddingHorizontal={8}
            paddingVertical={4}
            borderBottomWidth={i === rows.length - 1 ? 0 : 1}
            borderBottomColor={c.border}
          >
            {columns.map((col) => (
              <YStack key={col.key} width={col.width ?? 'auto'} flex={col.width ? undefined : 1}>
                {col.render(row)}
              </YStack>
            ))}
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

function Cell({ text, muted = false }: { text: string; muted?: boolean }) {
  const c = useColors();
  return (
    <Text color={muted ? c.text3 : c.text} fontSize={10} numberOfLines={1}>
      {text}
    </Text>
  );
}

/**
 * Card-shell estándar para todos los renderers TerosCore. Guide §2: el
 * dot ya comunica el status (running/completed/failed/pending_permission),
 * no se añade `badge` con el mismo texto (anti-pattern §7 DON'T
 * "Show a badge that duplicates what the dot already says"). Cada
 * renderer compone su `description` con `useCoreDescription`.
 *
 * `irreversible` se propaga desde el dispatch para que las tools
 * destructivas (delete/uninstall/revoke/archive/remove) muestren el
 * Irreversibility Indicator en el header (guide §8 — binary).
 */
function ToolShell({
  toolName,
  status,
  error,
  appIcon,
  description,
  children,
  irreversible,
}: {
  toolName: string;
  status: ToolCallRendererProps['status'];
  error?: string;
  appIcon?: string;
  description: string;
  children: React.ReactNode;
  irreversible?: boolean;
}) {
  // Auto-derive `irreversible` from the tool name when the caller didn't
  // override. Keeps the binding in one place (guide §8 — binary).
  const isIrreversible = irreversible ?? isIrreversibleTool(toolName);
  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      defaultExpanded={false}
      irreversible={isIrreversible}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && children}
    </ToolCallCard>
  );
}

// ============================================================================
// 3.A RENDERERS — AGENTS
// ============================================================================

function agentTitle(a: Agent): string {
  return a.fullName ?? a.name ?? a.agentId;
}

function agentLeadingAvatar(a: Agent, size = 22): React.ReactNode {
  return <Avatar src={a.avatarUrl || a.core?.avatarUrl} name={a.fullName ?? a.name} size={size} />;
}

function ListAgentsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: agents, nextCursor } = unwrapList<Agent>(parsed, 'agents');

  const workspaceName = useWorkspaceName(props.input?.workspaceId);
  const scoped = typeof props.input?.workspaceId === 'string';
  const description = useCoreDescription(
    scoped ? 'listWorkspaceAgents' : 'listAgents',
    status,
    scoped ? { workspace: workspaceName } : undefined,
  );
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {agents.length === 0 ? (
        <Empty message="No agents found" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {agents.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.agentId}
                leading={agentLeadingAvatar(a, 22)}
                title={agentTitle(a)}
                subtitle={a.role ? `${a.role} · ${a.workspaceId ?? 'global'}` : (a.workspaceId ?? 'global')}
                meta={<Cell text={formatDate(a.createdAt)} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
      {nextCursor && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono" marginTop={4}>
          more available · pass cursor="{truncate(nextCursor, 16)}"
        </Text>
      )}
    </ToolShell>
  );
}

function agentDetailRows(a: Agent): KeyValueRow[] {
  return [
    { key: 'agentId', value: shortId(a.agentId) },
    { key: 'core', value: a.core?.fullName ?? a.coreId ?? '—' },
    { key: 'workspace', value: a.workspaceId ?? 'global' },
    { key: 'owner', value: shortId(a.ownerId) },
    { key: 'maxSteps', value: a.maxSteps ? String(a.maxSteps) : '—' },
    { key: 'created', value: formatDate(a.createdAt) },
    { key: 'updated', value: formatDate(a.updatedAt) },
  ];
}

function GetAgentRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const agent = unwrap<Agent>(parsed, 'agent', 'agentId');

  const storedName = useAgentName(props.input?.agentId);
  const description = useCoreDescription('getAgent', status, {
    agent: firstName(agent?.fullName, agent?.name, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {agent && (
        <ResourceCard
          leading={agentLeadingAvatar(agent, 36)}
          title={agentTitle(agent)}
          subtitle={agent.role ?? '—'}
          meta={
            <IconChip
              text={agent.workspaceId ?? 'global'}
              accent={agent.workspaceId ? colors.indigo : c.text3}
              outline
            />
          }
        >
          <KeyValueGrid rows={agentDetailRows(agent)} />
          {agent.intro && (
            <YStack gap={3} marginTop={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                intro
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(agent.intro, 200)}
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

interface AgentAppAccess {
  appId: string;
  /** Field returned by list-agent-apps. */
  name?: string;
  appName?: string;
  mcaId?: string;
  mcaName?: string;
  grantedAt?: string;
}

function AgentAppsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: apps } = unwrapList<AgentAppAccess>(parsed, 'apps');

  const agentName = useAgentName(props.input?.agentId);
  const description = useCoreDescription('listAgentApps', status, { agent: agentName });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {apps.length === 0 ? (
        <Empty message="No apps granted to this agent" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {apps.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.appId}
                leading={<IconTile label={(a.name ?? a.appName ?? '?').slice(0, 2)} size={22} radius={5} />}
                title={a.name ?? a.appName ?? '—'}
                subtitle={a.mcaName ?? a.mcaId ?? '—'}
                meta={<Cell text={formatDate(a.grantedAt)} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

interface AgentProvidersOutput {
  agentId?: string;
  selectedProviderId?: string | null;
  selectedModelId?: string;
  /** 2-level model resolution (2026-10-21): agent_pin | user_default_provider | unresolved */
  resolved?: { providerId?: string; modelId?: string; source?: string };
  providers?: Array<{ providerId: string; name?: string; status?: string; models?: unknown[] }>;
}

function AgentProvidersRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = parsed && typeof parsed === 'object' ? (parsed as AgentProvidersOutput) : null;

  const agentName = useAgentName(props.input?.agentId);
  const description = useCoreDescription('getAgentProviders', status, { agent: agentName });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {data && (
        <EntityCard
          title={t('mca.terosCore.providersConfig')}
          subtitle={data.agentId ? shortId(data.agentId) : undefined}
        >
          <KeyValueGrid
            rows={[
              {
                key: 'resolved',
                value: data.resolved
                  ? `${data.resolved.modelId ?? '—'} (${data.resolved.source ?? '—'})`
                  : data.selectedModelId ?? '— (system default)',
              },
              { key: 'model', value: data.selectedModelId ?? '—' },
              { key: 'total', value: `${data.providers?.length ?? 0} providers` },
            ]}
          />
        </EntityCard>
      )}
    </ToolShell>
  );
}

function CreateAgentRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const agent = unwrap<Agent>(parsed, 'agent', 'agentId');

  const description = useCoreDescription('createAgent', status, {
    agent: firstName(agent?.fullName, agent?.name, props.input?.fullName, props.input?.name),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {agent && (
        <ResourceCard
          leading={agentLeadingAvatar(agent, 32)}
          title={agentTitle(agent)}
          subtitle={agent.role ?? '—'}
          verb="created"
          meta={
            <IconChip
              text={agent.workspaceId ?? 'global'}
              accent={agent.workspaceId ? colors.indigo : c.text3}
              outline
            />
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'agentId', value: shortId(agent.agentId) },
              { key: 'core', value: agent.coreId ?? '—' },
              ...(agent.intro ? [{ key: 'intro', value: truncate(agent.intro, 80) } as KeyValueRow] : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function UpdateAgentRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const agent = unwrap<Agent>(parsed, 'agent', 'agentId');
  const changes = diffFields(input, ['name', 'fullName', 'role', 'intro', 'context', 'avatarUrl', 'responseStyle']);

  const storedName = useAgentName(input?.agentId);
  const description = useCoreDescription('updateAgent', status, {
    agent: firstName(agent?.fullName, agent?.name, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {agent && (
        <ResourceCard
          leading={agentLeadingAvatar(agent, 32)}
          title={agentTitle(agent)}
          subtitle={agent.role ?? '—'}
          verb="updated"
        >
          {changes.length > 0 ? (
            <>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                changes
              </Text>
              <KeyValueGrid rows={changes} />
            </>
          ) : (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              (no visible changes)
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

interface DeleteResult {
  agentId?: string;
  name?: string;
  fullName?: string;
}

function DeleteAgentRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as DeleteResult;
  const name = data.fullName ?? data.name ?? (input?.agentId as string | undefined) ?? data.agentId ?? '?';

  const storedName = useAgentName(input?.agentId);
  const description = useCoreDescription('deleteAgent', status, {
    agent: firstName(data.fullName, data.name, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <EntityCard
        leading={<Avatar name={name} size={22} />}
        title={name}
        subtitle={shortId(data.agentId ?? (input?.agentId as string | undefined))}
        meta={<ActionBadge verb="deleted" />}
      />
    </ToolShell>
  );
}

interface SetAgentModelResult {
  agentId?: string;
  agentName?: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  /** Audit-only (goes to the server log) — never painted. */
  reason?: string | null;
}

function SetAgentModelRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SetAgentModelResult;
  const modelId = data.selectedModelId ?? (input?.modelId as string | undefined) ?? null;
  const providerId = data.selectedProviderId ?? (input?.providerId as string | undefined) ?? null;

  const storedName = useAgentName(input?.agentId);
  const description = useCoreDescription('setAgentModel', status, {
    agent: firstName(data.agentName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <ResourceCard
        leading={<Avatar name={data.agentName} size={28} />}
        title={data.agentName ?? shortId(data.agentId)}
        subtitle={t('mca.terosCore.modelPinned')}
        verb="updated"
      >
        <YStack gap={6}>
          {modelId ? (
            <IconChip text={modelId} accent={colors.indigo} outline />
          ) : (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              (no model pinned)
            </Text>
          )}
          {providerId && (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              {t('mca.terosCore.viaProvider', { provider: providerId })}
            </Text>
          )}
        </YStack>
      </ResourceCard>
    </ToolShell>
  );
}

interface ResetAgentModelResult {
  agentId?: string;
  agentName?: string;
  selectedProviderId?: null;
  selectedModelId?: null;
}

function ResetAgentModelRenderer(props: ToolCallRendererProps) {
  const { t } = useTranslation();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as ResetAgentModelResult;

  const storedName = useAgentName(input?.agentId);
  const description = useCoreDescription('resetAgentModel', status, {
    agent: firstName(data.agentName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <ResourceCard
        leading={<Avatar name={data.agentName} size={28} />}
        title={data.agentName ?? shortId(data.agentId)}
        subtitle={t('mca.terosCore.modelReset')}
        verb="updated"
      >
        <IconChip text={t('mca.terosCore.systemDefault')} accent={colors.indigo} outline />
      </ResourceCard>
    </ToolShell>
  );
}

// ============================================================================
// 3.B RENDERERS — WORKSPACES
// ============================================================================

function workspaceLeading(w: Workspace, size = 24): React.ReactNode {
  return (
    <IconTile
      label={(w.name ?? w.workspaceId).slice(0, 2)}
      accent={workspaceAccent(w)}
      size={size}
      radius={size >= 32 ? 6 : 5}
    />
  );
}

function workspaceTitle(w: Workspace): string {
  return w.name ?? w.workspaceId;
}

function ListWorkspacesRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: workspaces } = unwrapList<Workspace>(parsed, 'workspaces');

  const description = useCoreDescription('listWorkspaces', status);
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {workspaces.length === 0 ? (
        <Empty message="No workspaces found" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {workspaces.slice(0, MAX_ITEMS).map((w) => (
              <EntityRow
                key={w.workspaceId}
                leading={workspaceLeading(w)}
                title={workspaceTitle(w)}
                subtitle={w.description ?? shortId(w.workspaceId)}
                badges={
                  w.type && (
                    <IconChip
                      text={w.type}
                      accent={w.type === 'private' ? c.text3 : colors.indigo}
                      outline
                    />
                  )
                }
                meta={
                  <XStack gap={6} alignItems="center">
                    <Cell text={`${w.members?.length ?? 0} members`} muted />
                    <Cell text={formatDate(w.createdAt)} muted />
                  </XStack>
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

function workspaceDetailRows(w: Workspace): KeyValueRow[] {
  return [
    { key: 'workspaceId', value: shortId(w.workspaceId, 14) },
    { key: 'owner', value: shortId(w.ownerId) },
    { key: 'volume', value: shortId(w.volumeId) },
    { key: 'status', value: w.status ?? '—' },
    { key: 'created', value: formatDate(w.createdAt) },
  ];
}

function GetWorkspaceRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const ws = unwrap<Workspace>(parsed, 'workspace', 'workspaceId');

  const storedName = useWorkspaceName(props.input?.workspaceId);
  const description = useCoreDescription('getWorkspace', status, {
    workspace: firstName(ws?.name, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {ws && (
        <ResourceCard
          leading={workspaceLeading(ws, 36)}
          title={workspaceTitle(ws)}
          subtitle={ws.description ?? shortId(ws.workspaceId)}
          meta={
            ws.type && (
              <IconChip
                text={ws.type}
                accent={ws.type === 'private' ? c.text3 : colors.indigo}
                outline
              />
            )
          }
        >
          <KeyValueGrid rows={workspaceDetailRows(ws)} />
          {ws.members && ws.members.length > 0 && (
            <YStack gap={4} marginTop={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                members ({ws.members.length})
              </Text>
              <PillList items={ws.members.map((m) => `${shortId(m.userId, 8, 2)} · ${m.role}`)} max={6} />
            </YStack>
          )}
          {ws.context && ws.context.length > 0 && (
            <YStack gap={3} marginTop={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                context
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(ws.context, 200)}
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function CreateWorkspaceRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const ws = unwrap<Workspace>(parsed, 'workspace', 'workspaceId');

  const description = useCoreDescription('createWorkspace', status, {
    workspace: firstName(ws?.name, props.input?.name),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {ws && (
        <ResourceCard
          leading={workspaceLeading(ws, 32)}
          title={workspaceTitle(ws)}
          subtitle={ws.description ?? shortId(ws.workspaceId)}
          verb="created"
          meta={
            ws.type && (
              <IconChip text={ws.type} accent={colors.indigo} outline />
            )
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'workspaceId', value: shortId(ws.workspaceId, 14) },
              { key: 'owner', value: shortId(ws.ownerId) },
              ...(ws.volumeId ? [{ key: 'volume', value: shortId(ws.volumeId) } as KeyValueRow] : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function UpdateWorkspaceRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const ws = unwrap<Workspace>(parsed, 'workspace', 'workspaceId');
  const changes = diffFields(input, ['name', 'description', 'context', 'appearance']);

  const storedName = useWorkspaceName(input?.workspaceId);
  const description = useCoreDescription('updateWorkspace', status, {
    workspace: firstName(ws?.name, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {ws && (
        <ResourceCard
          leading={workspaceLeading(ws, 32)}
          title={workspaceTitle(ws)}
          subtitle={shortId(ws.workspaceId)}
          verb="updated"
        >
          {changes.length > 0 ? (
            <>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                changes
              </Text>
              <KeyValueGrid rows={changes} />
            </>
          ) : (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              (no visible changes)
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

interface WorkspaceActionResult {
  workspaceId?: string;
  name?: string;
  workspaceName?: string;
}

function ArchiveWorkspaceRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as WorkspaceActionResult;
  const name = data.name ?? data.workspaceName ?? shortId(data.workspaceId ?? (input?.workspaceId as string | undefined));

  const storedName = useWorkspaceName(input?.workspaceId);
  const description = useCoreDescription('archiveWorkspace', status, {
    workspace: firstName(data.name, data.workspaceName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <EntityCard
        leading={<IconTile label={name.slice(0, 2)} accent={c.text3} size={24} radius={5} />}
        title={name}
        subtitle={shortId(data.workspaceId ?? (input?.workspaceId as string | undefined))}
        meta={<ActionBadge verb="archived" />}
      />
    </ToolShell>
  );
}

interface MemberActionResult {
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  userName?: string;
  role?: string;
}

function AddWorkspaceMemberRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as MemberActionResult;
  const wsName = data.workspaceName ?? shortId(data.workspaceId ?? (input?.workspaceId as string | undefined));
  const userName = data.userName ?? shortId(data.userId ?? (input?.userId as string | undefined));
  const role = data.role ?? (input?.role as string | undefined) ?? '?';

  const storedName = useWorkspaceName(input?.workspaceId);
  const description = useCoreDescription('addWorkspaceMember', status, {
    email: firstName(input?.email),
    workspace: firstName(data.workspaceName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DualEntity
        left={{
          visual: <Avatar name={userName} size={24} />,
          title: userName,
          subtitle: role,
        }}
        right={{
          visual: <IconTile label={wsName.slice(0, 2)} size={24} radius={5} />,
          title: wsName,
          subtitle: 'workspace',
        }}
        action="add-member"
        meta={role}
      />
    </ToolShell>
  );
}

function RemoveWorkspaceMemberRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as MemberActionResult;
  const wsName = data.workspaceName ?? shortId(data.workspaceId ?? (input?.workspaceId as string | undefined));
  const userName = data.userName ?? shortId(data.userId ?? (input?.userId as string | undefined));

  const storedName = useWorkspaceName(input?.workspaceId);
  const description = useCoreDescription('removeWorkspaceMember', status, {
    workspace: firstName(data.workspaceName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DualEntity
        left={{
          visual: <Avatar name={userName} size={24} />,
          title: userName,
          subtitle: 'user',
        }}
        right={{
          visual: <IconTile label={wsName.slice(0, 2)} size={24} radius={5} />,
          title: wsName,
          subtitle: 'workspace',
        }}
        action="remove-member"
      />
    </ToolShell>
  );
}

function UpdateWorkspaceMemberRoleRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as MemberActionResult;
  const wsName = data.workspaceName ?? shortId(data.workspaceId ?? (input?.workspaceId as string | undefined));
  const userName = data.userName ?? shortId(data.userId ?? (input?.userId as string | undefined));
  const role = data.role ?? (input?.role as string | undefined) ?? '?';

  const storedName = useWorkspaceName(input?.workspaceId);
  const description = useCoreDescription('updateWorkspaceMemberRole', status, {
    workspace: firstName(data.workspaceName, storedName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DualEntity
        left={{
          visual: <Avatar name={userName} size={24} />,
          title: userName,
          subtitle: 'user',
        }}
        right={{
          visual: <IconTile label={wsName.slice(0, 2)} size={24} radius={5} />,
          title: wsName,
          subtitle: 'workspace',
        }}
        action="role-change"
        meta={role}
      />
    </ToolShell>
  );
}

// ============================================================================
// 3.C RENDERERS — APPS
// ============================================================================

function appLeading(a: Pick<App, 'name' | 'appId' | 'icon' | 'color'>, size = 24): React.ReactNode {
  return (
    <IconTile
      src={a.icon}
      label={(a.name ?? a.appId).slice(0, 2)}
      accent={a.color}
      size={size}
      radius={size >= 32 ? 6 : 5}
    />
  );
}

function appTitle(a: App): string {
  return a.name ?? a.appId;
}

function ListAppsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: apps } = unwrapList<App>(parsed, 'apps');

  const workspaceName = useWorkspaceName(props.input?.workspaceId);
  // list-apps (unscoped) was removed from the core MCA (fb_3dcf1df824a1b5ee) —
  // only workspace-app-list calls reach this renderer now, always scoped.
  const description = useCoreDescription('listWorkspaceApps', status, {
    workspace: workspaceName,
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {apps.length === 0 ? (
        <Empty message="No apps found" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {apps.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.appId}
                leading={appLeading(a, 24)}
                title={appTitle(a)}
                subtitle={a.mcaName ?? a.mcaId ?? '—'}
                badges={
                  a.status && (
                    <IconChip
                      text={a.status}
                      accent={a.status === 'active' ? colors.green : c.text3}
                      outline
                    />
                  )
                }
                meta={<Cell text={formatDate(a.createdAt)} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

function GetAppRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const app = unwrap<App>(parsed, 'app', 'appId');

  const storedName = useAppName(props.input?.appId);
  const description = useCoreDescription('getApp', status, { app: firstName(app?.name, storedName) });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {app && (
        <ResourceCard
          leading={appLeading(app, 36)}
          title={appTitle(app)}
          subtitle={app.mcaName ?? app.mcaId ?? '—'}
          meta={
            app.status && (
              <IconChip
                text={app.status}
                accent={app.status === 'active' ? colors.green : c.text3}
                outline
              />
            )
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'appId', value: shortId(app.appId, 14) },
              { key: 'mcaId', value: app.mcaId ?? '—' },
              { key: 'owner', value: `${app.ownerType ?? '?'}:${shortId(app.ownerId)}` },
              { key: 'created', value: formatDate(app.createdAt) },
            ]}
          />
          {app.description && (
            <Text color={c.text} fontSize={10} marginTop={4}>
              {truncate(app.description, 200)}
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function InstallAppRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const app = unwrap<App>(parsed, 'app', 'appId');

  const description = useCoreDescription('installApp', status, {
    app: firstName(app?.name, props.input?.name, app?.mcaName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {app && (
        <ResourceCard
          leading={appLeading(app, 32)}
          title={appTitle(app)}
          subtitle={app.mcaName ?? app.mcaId ?? '—'}
          verb="installed"
        >
          <KeyValueGrid
            rows={[
              { key: 'appId', value: shortId(app.appId, 14) },
              { key: 'mcaId', value: app.mcaId ?? '—' },
              { key: 'workspace', value: shortId(app.ownerId) },
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

interface AppActionResult {
  appId?: string;
  name?: string;
}

function UninstallAppRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as AppActionResult;
  const name = data.name ?? shortId(data.appId ?? (input?.appId as string | undefined));

  const storedName = useAppName(input?.appId);
  const description = useCoreDescription('uninstallApp', status, { app: firstName(data.name, storedName) });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <EntityCard
        leading={<IconTile label={name.slice(0, 2)} accent={colors.red} size={24} radius={5} />}
        title={name}
        subtitle={shortId(data.appId ?? (input?.appId as string | undefined))}
        meta={<ActionBadge verb="uninstalled" />}
      />
    </ToolShell>
  );
}

function RenameAppRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const app = unwrap<App>(parsed, 'app', 'appId');
  const newName = app?.name ?? (input?.name as string | undefined) ?? '?';

  const description = useCoreDescription('renameApp', status, { name: firstName(app?.name, input?.name) });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <ResourceCard
        leading={<IconTile label={newName.slice(0, 2)} size={28} radius={5} />}
        title={newName}
        subtitle={shortId(app?.appId ?? (input?.appId as string | undefined))}
        verb="renamed"
      />
    </ToolShell>
  );
}

interface AppAccessResult {
  agentId?: string;
  agentName?: string;
  appId?: string;
  appName?: string;
  grantedAt?: string;
  grantedBy?: string;
}

function GrantAppAccessRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as AppAccessResult;
  const agentName = data.agentName ?? shortId(data.agentId ?? (input?.agentId as string | undefined));
  const appName = data.appName ?? shortId(data.appId ?? (input?.appId as string | undefined));

  const storedAgent = useAgentName(input?.agentId);
  const storedApp = useAppName(input?.appId);
  const description = useCoreDescription('grantAppAccess', status, {
    agent: firstName(data.agentName, storedAgent),
    app: firstName(data.appName, storedApp),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DualEntity
        left={{
          visual: <Avatar name={agentName} size={24} />,
          title: agentName,
          subtitle: 'agent',
        }}
        right={{
          visual: <IconTile label={appName.slice(0, 2)} size={24} radius={5} />,
          title: appName,
          subtitle: 'app',
        }}
        action="grant"
      />
    </ToolShell>
  );
}

function RevokeAppAccessRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as AppAccessResult;
  const agentName = data.agentName ?? shortId(data.agentId ?? (input?.agentId as string | undefined));
  const appName = data.appName ?? shortId(data.appId ?? (input?.appId as string | undefined));

  const storedAgent = useAgentName(input?.agentId);
  const storedApp = useAppName(input?.appId);
  const description = useCoreDescription('revokeAppAccess', status, {
    agent: firstName(data.agentName, storedAgent),
    app: firstName(data.appName, storedApp),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DualEntity
        left={{
          visual: <Avatar name={agentName} size={24} />,
          title: agentName,
          subtitle: 'agent',
        }}
        right={{
          visual: <IconTile label={appName.slice(0, 2)} size={24} radius={5} />,
          title: appName,
          subtitle: 'app',
        }}
        action="revoke"
      />
    </ToolShell>
  );
}

interface AppAccessEntry {
  agentId: string;
  /** Fields returned by list-app-access. */
  name?: string;
  fullName?: string;
  agentName?: string;
  agentFullName?: string;
  grantedAt?: string;
  grantedBy?: string;
}

function AppAccessListRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: agents } = unwrapList<AppAccessEntry>(parsed, 'agents');

  const appName = useAppName(props.input?.appId);
  const description = useCoreDescription('listAppAccess', status, { app: appName });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {agents.length === 0 ? (
        <Empty message="No agents have access to this app" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {agents.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.agentId}
                leading={<Avatar name={a.fullName ?? a.name ?? a.agentFullName ?? a.agentName} size={22} />}
                title={a.fullName ?? a.name ?? a.agentFullName ?? a.agentName ?? '—'}
                subtitle={a.fullName && a.name && a.fullName !== a.name ? a.name : undefined}
                meta={<Cell text={formatDate(a.grantedAt)} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

interface AppPermissionsOutput {
  appId?: string;
  appName?: string;
  defaultPermission?: string;
  tools?: Array<{ name: string; permission: string; readOnly?: boolean }>;
  summary?: { allow: number; ask: number; forbid: number };
}

/** Shared by get-app-permissions and set-app-permissions (same output shape). */
function AppPermissionsRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as AppPermissionsOutput;
  const storedName = useAppName(input?.appId);
  const isSet = getShortToolName(toolName) === 'set-app-permissions';
  const description = useCoreDescription(isSet ? 'setAppPermissions' : 'getAppPermissions', status, {
    app: firstName(data.appName, storedName),
  });

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {data.summary && (
        <KeyValueGrid
          rows={[
            { key: 'allow', value: String(data.summary.allow) },
            { key: 'ask', value: String(data.summary.ask) },
            { key: 'forbid', value: String(data.summary.forbid) },
            ...(data.defaultPermission
              ? [{ key: 'default', value: data.defaultPermission } as KeyValueRow]
              : []),
          ]}
        />
      )}
    </ToolShell>
  );
}

// ── show-app-auth: inline auth widget ──────────────────────────────────────

interface ShowAppAuthInfo {
  status?: 'ready' | 'needs_user_auth' | 'expired' | 'error' | 'needs_system_setup' | 'not_required';
  authType?: 'none' | 'agent' | 'apikey' | 'oauth2' | 'github-app';
  message?: string;
  /**
   * API-key auth detail. `fields` mirrors the manifest's userSecrets with
   * `isSet` presence per variable — the value itself NEVER leaves the
   * backend, so the widget can list set/empty state without exposing keys.
   */
  apikey?: {
    configured?: boolean;
    fields?: Array<{
      name: string;
      label?: string;
      type?: 'text' | 'password';
      required?: boolean;
      placeholder?: string;
      hint?: string;
      isSet?: boolean;
    }>;
  };
}

interface ShowAppAuthOutput {
  displayed?: boolean;
  appId?: string;
  appName?: string;
  /** mcaId of the TARGET app (not the core's) — its icon is derived from it. */
  mcaId?: string;
  auth?: ShowAppAuthInfo;
}

const AUTH_STATUS_CHIP: Record<
  NonNullable<ShowAppAuthInfo['status']>,
  { text: string; outcome: string; accent: string }
> = {
  // `text` is the badge; `outcome` reads after "Checked <app> app auth: …".
  ready: { text: 'connected', outcome: 'authenticated', accent: colors.green },
  needs_user_auth: { text: 'not connected', outcome: 'not connected', accent: colors.amber },
  expired: { text: 'expired', outcome: 'session expired', accent: colors.amber },
  error: { text: 'error', outcome: 'error', accent: colors.red },
  needs_system_setup: { text: 'needs setup', outcome: 'needs setup', accent: colors.red },
  not_required: { text: 'no auth required', outcome: 'no auth required', accent: '#6b7280' },
};

/**
 * Display name for the target app in headers. While the tool runs there is
 * no output yet, so resolve the input's appId against the navbar store
 * (installed apps cache) instead of surfacing a raw `app_…` id. Undefined
 * when the name is unknown — headers then drop the name ("Checking app
 * auth"), never showing a raw id.
 */
function useAppDisplayName(
  parsedName: string | undefined,
  appId: string | undefined,
): string | undefined {
  const storedName = useAppName(appId);
  return firstName(parsedName, storedName);
}

function AuthActionButton({
  label,
  onPress,
  disabled,
  variant = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
}) {
  const isDanger = variant === 'danger';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderRadius: 6,
        backgroundColor: isDanger ? 'rgba(239,68,68,0.10)' : 'rgba(94,106,210,0.14)',
        borderWidth: 1,
        borderColor: isDanger ? 'rgba(239,68,68,0.35)' : 'rgba(94,106,210,0.35)',
        opacity: disabled ? 0.5 : 1,
        alignSelf: 'stretch',
      }}
    >
      <Text fontSize={11} color={isDanger ? colors.red : colors.indigo} fontWeight="600">
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * One variable row of the expandable secrets section: label + set/empty
 * chip, and a masked input that saves via `app.configure-credentials`
 * (partial merge — only the edited key is sent, never the stored ones).
 * The typed value lives in local state only: it is never rendered as text,
 * never logged and never passes through the model (the widget is client UI
 * talking straight to the backend transport).
 */
function SecretVariableRow({
  field,
  disabled,
  onSave,
}: {
  field: NonNullable<ShowAppAuthInfo['apikey']>['fields'] extends (infer F)[] | undefined ? F : never;
  disabled?: boolean;
  onSave: (name: string, value: string) => Promise<void>;
}) {
  const c = useColors();
  const [editing, setEditing] = useState(!field.isSet);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSet = field.isSet === true;

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(field.name, value);
      setValue('');
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <YStack gap={4}>
      <XStack alignItems="center" gap={6} flexWrap="wrap">
        <Text color={c.text} fontSize={11} fontFamily="$mono" numberOfLines={1} flex={1} minWidth={100}>
          {field.label ?? field.name}
        </Text>
        <IconChip
          text={isSet ? 'set' : field.required === false ? 'optional' : 'empty'}
          accent={isSet ? colors.success : field.required === false ? c.text3 : colors.warning}
          outline
        />
      </XStack>
      {editing ? (
        <XStack gap={6} alignItems="center">
          <TextInput
            value={value}
            onChangeText={setValue}
            editable={!saving && !disabled}
            secureTextEntry={field.type !== 'text'}
            placeholder={isSet ? 'Replace value…' : (field.placeholder ?? 'Paste value…')}
            placeholderTextColor={c.text3}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              flex: 1,
              height: 32,
              paddingHorizontal: 10,
              backgroundColor: c.bgInner,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 6,
              color: c.text,
              fontSize: 11,
              fontFamily: FONT_SANS,
              ...(Platform.OS === 'web' ? { outlineColor: c.accent } : {}),
            }}
          />
          <TouchableOpacity
            onPress={save}
            disabled={saving || disabled || !value.trim()}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Save ${field.label ?? field.name}`}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 6,
              backgroundColor: 'rgba(94,106,210,0.14)',
              borderWidth: 1,
              borderColor: 'rgba(94,106,210,0.35)',
              opacity: saving || disabled || !value.trim() ? 0.5 : 1,
            }}
          >
            <Text fontSize={11} color={colors.indigo} fontWeight="600">
              {saving ? 'Saving…' : 'Save'}
            </Text>
          </TouchableOpacity>
          {isSet && (
            <TouchableOpacity
              onPress={() => {
                setEditing(false);
                setValue('');
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Cancel editing ${field.label ?? field.name}`}
              style={{ paddingHorizontal: 6, paddingVertical: 7 }}
            >
              <Text fontSize={11} color={c.text3}>
                Cancel
              </Text>
            </TouchableOpacity>
          )}
        </XStack>
      ) : (
        <TouchableOpacity
          onPress={() => setEditing(true)}
          disabled={disabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${field.label ?? field.name}`}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text fontSize={10} color={colors.indigo} fontWeight="600">
            {'•'.repeat(12)}  Edit
          </Text>
        </TouchableOpacity>
      )}
      {field.hint && (
        <Text color={c.text3} fontSize={9}>
          {field.hint}
        </Text>
      )}
      {error && (
        <Text color={colors.red} fontSize={9}>
          {error}
        </Text>
      )}
    </YStack>
  );
}

/**
 * Interactive widget: renders the app's auth state IN the chat and lets the
 * user connect/reconnect right there (OAuth popup) without opening the app
 * window. For API-key apps the credentials form doesn't live in the chat:
 * the button opens the app window on its auth section.
 *
 * The result's state can go stale (old messages, reconnection done
 * elsewhere), so on mount it re-reads the live status via
 * `app.get-auth-status` and from then on the local state wins.
 */
function ShowAppAuthRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { status, output, error, input } = props;
  const parsed = output ? (parseOutput<ShowAppAuthOutput>(output) as ShowAppAuthOutput | null) : null;
  const appId = parsed?.appId ?? (input?.appId as string | undefined);
  const appName = useAppDisplayName(parsed?.appName, appId);
  // Body copy (only rendered on completed, where the output carries the name).
  const appTitle = appName ?? 'app';
  // Target app icon (convention /static/mcas/<mcaId>/icon.svg); fallback:
  // the core's icon (props.appIcon, the gear) and, with no URL at all, the
  // IconTile 2-letter label.
  const targetIcon = parsed?.mcaId
    ? `${backendUrl()}/static/mcas/${parsed.mcaId}/icon.svg`
    : props.appIcon;

  const [liveAuth, setLiveAuth] = useState<ShowAppAuthInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const auth = liveAuth ?? parsed?.auth ?? null;

  const refreshAuth = async () => {
    if (!appId) return;
    try {
      const res = await getTerosClient().app.getAuthStatus(appId);
      setLiveAuth(res.auth as ShowAppAuthInfo);
    } catch {
      // Best-effort: without live status we keep rendering the result's.
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshAuth is stable per appId
  useEffect(() => {
    if (status === 'completed' && appId) void refreshAuth();
  }, [status, appId]);

  const handleConnect = async () => {
    if (!appId) return;
    setConnecting(true);
    setActionError(null);
    try {
      await getTerosClient().connectAppOAuth(appId);
      await refreshAuth();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Connection failed');
      await refreshAuth();
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!appId) return;
    setDisconnecting(true);
    setActionError(null);
    try {
      await getTerosClient().app.disconnectAuth(appId);
      await refreshAuth();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Disconnect failed');
      await refreshAuth();
    } finally {
      setDisconnecting(false);
    }
  };

  const openAppWindow = () => {
    if (appId) useTilingStore.getState().openWindow('app', { appId });
  };

  const chip = auth?.status ? AUTH_STATUS_CHIP[auth.status] : undefined;
  const isOAuth = auth?.authType === 'oauth2' || auth?.authType === 'github-app';
  const isApikey = auth?.authType === 'apikey';
  const needsAction = auth?.status !== 'ready' && auth?.status !== 'not_required';
  const connectLabel = auth?.status === 'expired' || auth?.status === 'error' ? 'Reconnect' : 'Connect';
  // Variables the manifest declares for this app (userSecrets via apikey.fields).
  const secretFields = auth?.apikey?.fields ?? [];
  const setCount = secretFields.filter((f) => f.isSet).length;
  // Disconnect applies to every auth type with stored user credentials:
  // OAuth sessions AND apikey apps with at least one saved variable.
  const canDisconnect =
    (isOAuth && !needsAction) || (isApikey && (auth?.apikey?.configured === true || setCount > 0));
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [savingSecret, setSavingSecret] = useState(false);

  const handleSaveSecret = async (name: string, value: string) => {
    if (!appId) return;
    setSavingSecret(true);
    setActionError(null);
    try {
      // Partial merge: only the edited key travels to the backend — stored
      // secrets are never read back, so nothing else can be wiped or leaked.
      await getTerosClient().app.configureCredentials(appId, { [name]: value });
      await refreshAuth();
    } finally {
      setSavingSecret(false);
    }
  };

  const description = useCoreDescription('showAppAuth', status, { app: appName });
  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={props.appIcon}
      defaultExpanded
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={8}>
          <EntityCard
            leading={
              <IconTile src={targetIcon} label={appTitle.slice(0, 2)} size={26} radius={6} />
            }
            title={appTitle}
            subtitle={auth?.authType && auth.authType !== 'none' ? auth.authType : undefined}
            meta={chip && <IconChip text={chip.text} accent={chip.accent} outline />}
          />
          {auth?.message && (
            <Text color={c.text2} fontSize={10}>
              {auth.message}
            </Text>
          )}
          {needsAction && isOAuth && (
            <AuthActionButton
              label={connecting ? 'Waiting for the OAuth window…' : `${connectLabel} ${appTitle}`}
              onPress={handleConnect}
              disabled={connecting}
            />
          )}
          {needsAction && isApikey && secretFields.length === 0 && (
            <AuthActionButton label="Open app settings" onPress={openAppWindow} />
          )}
          {canDisconnect && (
            <AuthActionButton
              label={disconnecting ? 'Disconnecting…' : `Disconnect ${appTitle}`}
              onPress={() => setConfirmingDisconnect(true)}
              disabled={disconnecting}
              variant="danger"
            />
          )}
          {confirmingDisconnect && (
            <ConfirmDialog
              visible
              variant="deny"
              title={`Disconnect ${appTitle}?`}
              message={
                isApikey
                  ? 'All saved variables will be removed and agents will lose access until you set them again.'
                  : 'The connected account will be revoked and agents will lose access until you reconnect.'
              }
              onCancel={() => setConfirmingDisconnect(false)}
              onConfirm={() => {
                setConfirmingDisconnect(false);
                void handleDisconnect();
              }}
            />
          )}
          {isApikey && secretFields.length > 0 && (
            <YStack
              gap={8}
              paddingTop={8}
              borderTopWidth={1}
              borderTopColor={c.border}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${secretsExpanded ? 'Collapse' : 'Expand'} variables of ${appTitle}`}
                onPress={() => setSecretsExpanded(!secretsExpanded)}
                style={Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : undefined}
              >
                <XStack alignItems="center" gap={6}>
                  <Text color={c.text2} fontSize={10} fontWeight="600">
                    Variables ({setCount}/{secretFields.length} set)
                  </Text>
                  <Text color={c.text3} fontSize={10}>
                    {secretsExpanded ? '▾' : '▸'}
                  </Text>
                </XStack>
              </Pressable>
              {secretsExpanded && (
                <YStack gap={10}>
                  {secretFields.map((field) => (
                    <SecretVariableRow
                      key={field.name}
                      field={field}
                      disabled={savingSecret}
                      onSave={handleSaveSecret}
                    />
                  ))}
                </YStack>
              )}
            </YStack>
          )}
          {actionError && (
            <Text color={colors.red} fontSize={10}>
              {actionError}
            </Text>
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

/**
 * Informational sibling of ShowAppAuthRenderer: `check-app-auth` is an
 * agent-side read, so the card is a plain snapshot of the status at call
 * time — no connect button, no live refresh (that is show-app-auth's job).
 *
 * The header carries the OUTCOME ("gmail authentication: expired"), not a
 * conjugated tool label ("Checked app authentication"): the card ships
 * collapsed, so the header is the message.
 */
function CheckAppAuthRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { status, output, error, input } = props;
  const parsed = output ? (parseOutput<ShowAppAuthOutput>(output) as ShowAppAuthOutput | null) : null;
  const appId = parsed?.appId ?? (input?.appId as string | undefined);
  const appName = useAppDisplayName(parsed?.appName, appId);
  const appTitle = appName ?? 'app';
  const targetIcon = parsed?.mcaId
    ? `${backendUrl()}/static/mcas/${parsed.mcaId}/icon.svg`
    : props.appIcon;
  const auth = parsed?.auth ?? null;
  const chip = auth?.status ? AUTH_STATUS_CHIP[auth.status] : undefined;

  const description = useCoreDescription('checkAppAuth', status, { app: appName });
  return (
    <ToolCallCard
      status={status}
      description={description}
      // The outcome rides the header as a right-side badge (pattern used by
      // health checks): visible with the card collapsed, no text duplication.
      badge={
        status === 'completed' && chip ? (
          <IconChip text={chip.outcome} accent={chip.accent} outline />
        ) : undefined
      }
      iconUri={props.appIcon}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={8}>
          <EntityCard
            leading={<IconTile src={targetIcon} label={appTitle.slice(0, 2)} size={26} radius={6} />}
            title={appTitle}
            subtitle={auth?.authType && auth.authType !== 'none' ? auth.authType : undefined}
            meta={chip && <IconChip text={chip.text} accent={chip.accent} outline />}
          />
          {auth?.message && (
            <Text color={c.text2} fontSize={10}>
              {auth.message}
            </Text>
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ── App secrets (set / get) and auth copy ──────────────────────────────────
// Masked by contract: the backend never returns a secret value, only
// `maskedValue` ('sk_live_…4f2a'). The cards show the key, its mask and, for
// set-app-secret, how many messages the redaction sweep cleaned.

interface AppSecretResult {
  appId?: string;
  appName?: string;
  mcaId?: string;
  key?: string;
  scope?: string;
  configured?: boolean;
  maskedValue?: string;
  redaction?: { swept?: boolean; redactedCount?: number; error?: string };
}

interface CopyAppAuthResult {
  sourceAppId?: string;
  sourceAppName?: string;
  targetAppId?: string;
  targetAppName?: string;
  mcaId?: string;
  copiedFields?: Array<{ key?: string; maskedValue?: string }>;
  fieldCount?: number;
}

function SetAppSecretRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, input } = props;
  const parsed = output ? (parseOutput<AppSecretResult>(output) as AppSecretResult | null) : null;
  const appId = parsed?.appId ?? (input?.appId as string | undefined);
  const key = parsed?.key ?? (input?.key as string | undefined) ?? '?';
  const appName = useAppDisplayName(parsed?.appName, appId);
  const appTitle = appName ?? shortId(appId);

  const description = useCoreDescription('setAppSecret', status, { app: appName, key });
  const rows: KeyValueRow[] = [{ key, value: parsed?.maskedValue ?? '…', mono: true }];
  const redaction = parsed?.redaction;
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <YStack gap={8}>
        <EntityCard
          leading={<IconTile label={appTitle.slice(0, 2)} size={26} radius={6} />}
          title={appTitle}
          subtitle={shortId(appId)}
          meta={status === 'completed' ? <IconChip text="saved" accent={colors.success} outline /> : undefined}
        />
        {status === 'completed' && <KeyValueGrid rows={rows} />}
        {status === 'completed' && redaction?.swept && (
          <Text color={c.text2} fontSize={10}>
            {redaction.redactedCount ?? 0} message(s) redacted
          </Text>
        )}
      </YStack>
    </ToolShell>
  );
}

function GetAppSecretRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error, input } = props;
  const parsed = output ? (parseOutput<AppSecretResult>(output) as AppSecretResult | null) : null;
  const appId = parsed?.appId ?? (input?.appId as string | undefined);
  const key = parsed?.key ?? (input?.key as string | undefined) ?? '?';
  const appName = useAppDisplayName(parsed?.appName, appId);
  const appTitle = appName ?? shortId(appId);

  const description = useCoreDescription('getAppSecret', status, { app: appName, key });
  const configured = parsed?.configured === true;
  const rows: KeyValueRow[] = [{ key, value: configured ? (parsed?.maskedValue ?? '…') : '—', mono: true }];
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <YStack gap={8}>
        <EntityCard
          leading={<IconTile label={appTitle.slice(0, 2)} size={26} radius={6} />}
          title={appTitle}
          subtitle={shortId(appId)}
          meta={
            status === 'completed' ? (
              <IconChip
                text={configured ? 'configured' : 'not set'}
                accent={configured ? colors.success : colors.warning}
                outline
              />
            ) : undefined
          }
        />
        {status === 'completed' && <KeyValueGrid rows={rows} />}
      </YStack>
    </ToolShell>
  );
}

function CopyAppAuthRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error, input } = props;
  const parsed = output ? (parseOutput<CopyAppAuthResult>(output) as CopyAppAuthResult | null) : null;
  const sourceId = parsed?.sourceAppId ?? (input?.sourceAppId as string | undefined);
  const targetId = parsed?.targetAppId ?? (input?.targetAppId as string | undefined);
  const sourceName = useAppDisplayName(parsed?.sourceAppName, sourceId) ?? shortId(sourceId);
  const targetName = useAppDisplayName(parsed?.targetAppName, targetId) ?? shortId(targetId);

  const description = useCoreDescription('copyAppAuth', status, { source: sourceName, target: targetName });
  const fields = parsed?.copiedFields ?? [];
  const rows: KeyValueRow[] = fields.map((f) => ({
    key: f.key ?? '?',
    value: f.maskedValue ?? '…',
    mono: true,
  }));
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <YStack gap={8}>
        <DualEntity
          left={{
            visual: <IconTile label={sourceName.slice(0, 2)} size={24} radius={5} />,
            title: sourceName,
            subtitle: 'source',
          }}
          right={{
            visual: <IconTile label={targetName.slice(0, 2)} size={24} radius={5} />,
            title: targetName,
            subtitle: 'target',
          }}
          action="transfer"
        />
        {status === 'completed' && rows.length > 0 && <KeyValueGrid rows={rows} />}
      </YStack>
    </ToolShell>
  );
}

function ListCatalogRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: catalog } = unwrapList<CatalogEntry>(parsed, 'catalog');

  const description = useCoreDescription('listCatalog', status);
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {catalog.length === 0 ? (
        <Empty message="No catalog entries found" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {catalog.slice(0, MAX_ITEMS).map((c) => (
              <EntityRow
                key={c.mcaId}
                leading={<IconTile src={c.icon} label={(c.name ?? c.mcaId).slice(0, 2)} accent={c.color} size={26} />}
                title={c.name ?? c.mcaId}
                subtitle={c.mcaId}
                badges={
                  <XStack gap={4}>
                    {c.category && <IconChip text={c.category} accent={colors.indigo} outline />}
                    {c.auth?.type && c.auth.type !== 'none' && (
                      <IconChip text={c.auth.type} accent={colors.amber} outline />
                    )}
                  </XStack>
                }
                meta={<Cell text={`${c.tools?.length ?? 0} tools`} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

function ListProvidersRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: providers } = unwrapList<Provider>(parsed, 'providers');

  const description = useCoreDescription('listProviders', status);
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <DenseTable<Provider>
        rows={providers}
        emptyText="No providers configured"
        columns={[
          {
            key: 'provider',
            label: 'Provider',
            render: (p) => (
              <Cell text={p.displayName ?? p.name ?? p.providerType ?? p.providerId ?? '—'} />
            ),
          },
          {
            key: 'status',
            label: 'Status',
            width: 80,
            render: (p) => (
              <Badge
                text={p.status ?? '—'}
                variant={p.status === 'active' ? 'success' : 'gray'}
              />
            ),
          },
          {
            key: 'models',
            label: 'Models',
            width: 70,
            render: (p) => <Cell text={`${p.models?.length ?? 0}`} muted />,
          },
          {
            key: 'default',
            label: '',
            width: 40,
            render: (p) => (p.isDefault ? <Cell text="★" /> : <Cell text="" />),
          },
        ]}
      />
    </ToolShell>
  );
}

interface SetDefaultProviderResult {
  success?: boolean;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  previousDefaultProviderId?: string;
  isDefault?: boolean;
  /** Audit-only (goes to the server log) — never painted. */
  reason?: string | null;
}

/**
 * set-default-provider: the System Default is user-wide (every agent without
 * an explicit pin), so the card leads with the provider + its default model
 * chip and, when the default actually switched providers, a muted line with
 * the previous one. The backend `message` is composed copy — never painted.
 */
function SetDefaultProviderRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SetDefaultProviderResult;
  const providerName =
    data.providerName ?? shortId(data.providerId ?? (input?.providerId as string | undefined));
  const modelId = data.modelId ?? (input?.modelId as string | undefined) ?? null;
  const previous = data.previousDefaultProviderId;
  const switched =
    !!previous && previous !== (data.providerId ?? (input?.providerId as string | undefined));

  const description = useCoreDescription('setDefaultProvider', status, {
    provider: data.providerName,
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <ResourceCard
        leading={<IconTile label={providerName.slice(0, 2)} size={28} radius={5} />}
        title={providerName}
        subtitle={t('mca.terosCore.systemDefault')}
        verb="updated"
      >
        <YStack gap={6}>
          {modelId ? (
            <IconChip text={modelId} accent={colors.indigo} outline />
          ) : (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              (no model set)
            </Text>
          )}
          {switched && (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              {t('mca.terosCore.switchedFrom', { provider: shortId(previous) })}
            </Text>
          )}
        </YStack>
      </ResourceCard>
    </ToolShell>
  );
}

// ============================================================================
// 3.D RENDERERS — SKILLS
// ============================================================================

function skillLeading(s: Skill, size = 24): React.ReactNode {
  return <IconTile label={(s.name ?? s.skillId).slice(0, 2)} size={size} radius={5} />;
}

function skillTitle(s: Skill): string {
  return s.name ?? s.skillId;
}

function SkillListRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: skills } = unwrapList<Skill>(parsed, 'skills');

  // Also renders skill-get-agent-skills (same output shape).
  const forAgent = getShortToolName(toolName) === 'skill-get-agent-skills';
  const agentName = useAgentName(props.input?.agentId);
  const description = useCoreDescription(
    forAgent ? 'skillGetAgentSkills' : 'skillList',
    status,
    forAgent ? { agent: agentName } : undefined,
  );
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skills.length === 0 ? (
        <Empty message="No skills found" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {skills.slice(0, MAX_ITEMS).map((s) => (
              <EntityRow
                key={s.skillId}
                leading={skillLeading(s, 24)}
                title={skillTitle(s)}
                subtitle={s.description ?? shortId(s.skillId)}
                badges={s.category ? <IconChip text={s.category} accent={colors.indigo} outline /> : undefined}
                meta={s.tags && s.tags.length > 0 ? <PillList items={s.tags} max={3} /> : undefined}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

function SkillCreateRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const skill = unwrap<Skill>(parsed, 'skill', 'skillId');

  const description = useCoreDescription('skillCreate', status, {
    skill: firstName(skill?.name, props.input?.name),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skill && (
        <ResourceCard
          leading={skillLeading(skill, 32)}
          title={skillTitle(skill)}
          subtitle={skill.description ?? shortId(skill.skillId)}
          verb="created"
          meta={skill.category && <IconChip text={skill.category} accent={colors.indigo} outline />}
        >
          <KeyValueGrid
            rows={[
              { key: 'skillId', value: shortId(skill.skillId, 14) },
              { key: 'workspace', value: shortId(skill.workspaceId) },
              { key: 'createdBy', value: shortId(skill.createdBy) },
            ]}
          />
          {skill.content && (
            <YStack gap={3} marginTop={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                content preview
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(skill.content, 200)}
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function SkillUpdateRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const skill = unwrap<Skill>(parsed, 'skill', 'skillId');
  const changes = diffFields(input, ['name', 'description', 'content', 'category', 'tags']);

  const description = useCoreDescription('skillUpdate', status, {
    skill: firstName(skill?.name, input?.name),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skill && (
        <ResourceCard
          leading={skillLeading(skill, 32)}
          title={skillTitle(skill)}
          subtitle={shortId(skill.skillId)}
          verb="updated"
        >
          {changes.length > 0 ? (
            <>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                changes
              </Text>
              <KeyValueGrid rows={changes} />
            </>
          ) : (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              (no visible changes)
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

interface SkillActionResult {
  skillId?: string;
  skillName?: string;
  name?: string;
  agentId?: string;
  agentName?: string;
  enabled?: boolean;
}

function SkillDeleteRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SkillActionResult;
  const name = data.name ?? data.skillName ?? shortId(data.skillId ?? (input?.skillId as string | undefined));

  const description = useCoreDescription('skillDelete', status, {
    skill: firstName(data.name, data.skillName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      <EntityCard
        leading={<IconTile label={name.slice(0, 2)} accent={colors.red} size={24} radius={5} />}
        title={name}
        subtitle={shortId(data.skillId ?? (input?.skillId as string | undefined))}
        meta={<ActionBadge verb="deleted" />}
      />
    </ToolShell>
  );
}

function skillAgentDual(
  data: SkillActionResult,
  input: Record<string, unknown> | undefined,
  action: DualAction,
  meta?: string,
) {
  const agentName = data.agentName ?? shortId(data.agentId ?? (input?.agentId as string | undefined));
  const skillName = data.skillName ?? shortId(data.skillId ?? (input?.skillId as string | undefined));
  return (
    <DualEntity
      left={{ visual: <Avatar name={agentName} size={24} />, title: agentName, subtitle: 'agent' }}
      right={{
        visual: <IconTile label={skillName.slice(0, 2)} size={24} radius={5} />,
        title: skillName,
        subtitle: 'skill',
      }}
      action={action}
      meta={meta}
    />
  );
}

function SkillGrantAccessRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SkillActionResult;

  const storedAgent = useAgentName(input?.agentId);
  const description = useCoreDescription('skillGrantAccess', status, {
    agent: firstName(data.agentName, storedAgent),
    skill: firstName(data.skillName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skillAgentDual(data, input, 'grant')}
    </ToolShell>
  );
}

function SkillRevokeAccessRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SkillActionResult;

  const storedAgent = useAgentName(input?.agentId);
  const description = useCoreDescription('skillRevokeAccess', status, {
    agent: firstName(data.agentName, storedAgent),
    skill: firstName(data.skillName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skillAgentDual(data, input, 'revoke')}
    </ToolShell>
  );
}

function SkillSetEnabledRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SkillActionResult;
  const enabled = data.enabled ?? (input?.enabled as boolean | undefined) ?? false;

  const storedAgent = useAgentName(input?.agentId);
  const description = useCoreDescription(enabled ? 'skillEnable' : 'skillDisable', status, {
    agent: firstName(data.agentName, storedAgent),
    skill: firstName(data.skillName),
  });
  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
      appIcon={props.appIcon}
      description={description}
    >
      {skillAgentDual(data, input, enabled ? 'enable' : 'disable', enabled ? 'enabled' : 'disabled')}
    </ToolShell>
  );
}

function AgentSkillsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  // Reutiliza SkillListRenderer: mismo output shape { skills: [...] }.
  return <SkillListRenderer {...props} />;
}

// ============================================================================
// 4. FALLBACK (solo para tools sin renderer dedicado — idealmente nunca)
// ============================================================================

/**
 * Se activa cuando un tool del MCA Core cae aquí por no estar en el
 * registry. **Es una señal de bug**: todo tool debería tener renderer
 * dedicado. Por eso:
 *   - Pinta un warning visible (el dev lo ve en UI).
 *   - Muestra el output crudo con JsonPreview para debugging.
 *   - En producción queda como último recurso sin romper el chat.
 */
function FallbackRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, appIcon } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;

  const description = useCoreDescription('fallback', status);
  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={6}>
          <XStack
            backgroundColor="rgba(239,68,68,0.08)"
            borderWidth={1}
            borderColor={colors.red}
            padding={6}
            borderRadius={4}
          >
            <Text color={colors.red} fontSize={10} fontFamily="$mono">
              ⚠ No dedicated renderer for `{getShortToolName(toolName)}` — fix in TerosCoreRenderer.tsx
            </Text>
          </XStack>
          {/* Guide §7 DON'T: never show raw JSON as default body. Gated by
              __DEV__ — production falls back to a SuccessBlock so users see
              "Listed N agents" rather than a debug tree. */}
          {parsed !== null && parsed !== undefined && __DEV__ ? (
            <JsonPreview value={parsed} />
          ) : (
            <SuccessBlock message={description} />
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// 5. REGISTRY + ENTRY POINT
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Agents
  'list-agents': ListAgentsRenderer,
  'get-agent': GetAgentRenderer,
  'create-agent': CreateAgentRenderer,
  'update-agent': UpdateAgentRenderer,
  'delete-agent': DeleteAgentRenderer,
  'list-agent-apps': AgentAppsRenderer,
  'get-agent-providers': AgentProvidersRenderer,
  'set-agent-model': SetAgentModelRenderer,
  'reset-agent-model': ResetAgentModelRenderer,
  // Workspaces
  'list-workspaces': ListWorkspacesRenderer,
  'get-workspace': GetWorkspaceRenderer,
  'create-workspace': CreateWorkspaceRenderer,
  'update-workspace': UpdateWorkspaceRenderer,
  'archive-workspace': ArchiveWorkspaceRenderer,
  'add-workspace-member': AddWorkspaceMemberRenderer,
  'remove-workspace-member': RemoveWorkspaceMemberRenderer,
  'update-workspace-member-role': UpdateWorkspaceMemberRoleRenderer,
  'workspace-agent-list': ListAgentsRenderer,
  'workspace-app-list': ListAppsRenderer,
  // Apps
  'get-app': GetAppRenderer,
  'install-app': InstallAppRenderer,
  'uninstall-app': UninstallAppRenderer,
  'rename-app': RenameAppRenderer,
  'check-app-auth': CheckAppAuthRenderer,
  'set-app-secret': SetAppSecretRenderer,
  'get-app-secret': GetAppSecretRenderer,
  'copy-app-auth': CopyAppAuthRenderer,
  'show-app-auth': ShowAppAuthRenderer,
  'list-app-access': AppAccessListRenderer,
  'grant-app-access': GrantAppAccessRenderer,
  'revoke-app-access': RevokeAppAccessRenderer,
  'get-app-permissions': AppPermissionsRenderer,
  'set-app-permissions': AppPermissionsRenderer,
  // Catalog / Providers
  'list-catalog': ListCatalogRenderer,
  'list-providers': ListProvidersRenderer,
  'set-default-provider': SetDefaultProviderRenderer,
  // Skills
  'skill-list': SkillListRenderer,
  'skill-create': SkillCreateRenderer,
  'skill-update': SkillUpdateRenderer,
  'skill-delete': SkillDeleteRenderer,
  'skill-grant-access': SkillGrantAccessRenderer,
  'skill-revoke-access': SkillRevokeAccessRenderer,
  'skill-set-enabled': SkillSetEnabledRenderer,
  'skill-get-agent-skills': AgentSkillsRenderer,
};

function TerosCoreRendererBase(props: ToolCallRendererProps) {
  const c = useColors();
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const TerosCoreToolCallRenderer = withPermissionSupport(TerosCoreRendererBase);
export default TerosCoreToolCallRenderer;

// Re-export para tests internos: permite verificar cobertura del registry.
export const __TEST_RENDERERS = RENDERERS;
