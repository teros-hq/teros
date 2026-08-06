/**
 * mca.teros.core — Tool Call Renderer
 *
 * Cobertura 100%: cada uno de los 40 tools del MCA Core tiene un renderer
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
import { ScrollView, TouchableOpacity } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { getTerosClient } from '../../../services/terosClientSingleton';
import { useNavbarStore } from '../../../store/navbarStore';
import { useTilingStore } from '../../../store/tilingStore';

import {
  ActionBadge,
  Avatar,
  Badge,
  colors,
  useColors,
  DualEntity,
  type DualAction,
  Empty,
  EntityCard,
  EntityRow,
  ErrorBlock,
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
  tenseByStatus,
  ToolCallCard,
  truncate,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

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
  availableProviders?: string[];
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

const TOOL_LABELS: Record<string, string> = {
  // Agents
  'list-agents': 'Agents',
  'get-agent': 'Agent details',
  'create-agent': 'Create agent',
  'update-agent': 'Update agent',
  'delete-agent': 'Delete agent',
  'list-agent-apps': 'Agent apps',
  'get-agent-providers': 'Agent providers',
  'set-agent-providers': 'Set agent providers',
  'set-agent-preferred-provider': 'Set preferred provider',
  // Workspaces
  'list-workspaces': 'Workspaces',
  'get-workspace': 'Workspace details',
  'create-workspace': 'Create workspace',
  'update-workspace': 'Update workspace',
  'archive-workspace': 'Archive workspace',
  'add-workspace-member': 'Add member',
  'remove-workspace-member': 'Remove member',
  'update-workspace-member-role': 'Update member role',
  'workspace-agent-list': 'Workspace agents',
  'workspace-app-list': 'Workspace apps',
  // Apps
  'list-apps': 'Apps',
  'get-app': 'App details',
  'install-app': 'Install app',
  'uninstall-app': 'Uninstall app',
  'rename-app': 'Rename app',
  'check-app-auth': 'Check app authentication',
  'show-app-auth': 'App authentication',
  'list-app-access': 'App access',
  // Catalog / Providers
  'list-catalog': 'MCA catalog',
  'list-providers': 'LLM providers',
  // Access control (apps)
  'grant-app-access': 'Grant app access',
  'revoke-app-access': 'Revoke app access',
  // Skills
  'skill-list': 'Skills',
  'skill-create': 'Create skill',
  'skill-update': 'Update skill',
  'skill-delete': 'Delete skill',
  'skill-grant-access': 'Grant skill access',
  'skill-revoke-access': 'Revoke skill access',
  'skill-set-enabled': 'Toggle skill',
  'skill-get-agent-skills': 'Agent skills',
};

function humanize(name: string): string {
  if (!name) return '';
  const joined = name.replace(/-/g, ' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

/**
 * Best-effort tense derivation from the canonical tool label (guide §2):
 *   "List agents"   → { future: "list agents",   present: "Listing agents",   past: "Listed agents" }
 *   "Create agent"  → { future: "create agent",  present: "Creating agent",  past: "Created agent" }
 *   "Stat workspace" → falls through to a single static form
 *
 * The TOOL_LABELS table is verb-first so this works for ~all tools; the
 * fallback (humanize) yields a noun phrase that we treat as the past form.
 */
function getTenseForms(toolName: string): { future: string; present: string; past: string } {
  const label = getToolLabel(toolName);
  const lower = label.toLowerCase();
  const [verb, ...rest] = lower.split(' ');
  const tail = rest.join(' ');
  if (!verb) return { future: lower, present: label, past: label };
  const present = verb.endsWith('e') ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
  const past = verb.endsWith('e') ? `${verb}d` : `${verb}ed`;
  return {
    future: `${verb}${tail ? ` ${tail}` : ''}`,
    present: capitalize(`${present}${tail ? ` ${tail}` : ''}`),
    past: capitalize(`${past}${tail ? ` ${tail}` : ''}`),
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
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
 * Card-shell estándar para todos los renderers. Unifica el header (label +
 * status badge + duration) y el slot de body + error/empty handling.
 */
/**
 * Card-shell estándar para todos los renderers TerosCore. Guide §2: el
 * dot ya comunica el status (running/completed/failed/pending_permission),
 * no se añade `badge` con el mismo texto (anti-pattern §7 DON'T
 * "Show a badge that duplicates what the dot already says"). La
 * descripción se pasa por `tenseByStatus` para que respete el tense.
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
  children,
  irreversible,
}: {
  toolName: string;
  status: ToolCallRendererProps['status'];
  error?: string;
  appIcon?: string;
  children: React.ReactNode;
  irreversible?: boolean;
}) {
  const c = useColors();
  // Auto-derive `irreversible` from the tool name when the caller didn't
  // override. Keeps the binding in one place (guide §8 — binary).
  const isIrreversible = irreversible ?? isIrreversibleTool(toolName);
  return (
    <ToolCallCard
      status={status}
      description={tenseByStatus(status, getTenseForms(toolName))}
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {apps.length === 0 ? (
        <Empty message="No apps granted to this agent" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {apps.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.appId}
                leading={<IconTile label={(a.appName ?? a.appId).slice(0, 2)} size={22} radius={5} />}
                title={a.appName ?? a.appId}
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
  availableProviders?: string[];
  selectedProviderId?: string | null;
  selectedModelId?: string;
  providers?: Array<{ providerId: string; name?: string; status?: string; models?: unknown[] }>;
}

function AgentProvidersRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = parsed && typeof parsed === 'object' ? (parsed as AgentProvidersOutput) : null;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {data && (
        <EntityCard
          title={t('mca.terosCore.providersConfig')}
          subtitle={data.agentId ? shortId(data.agentId) : undefined}
        >
          <KeyValueGrid
            rows={[
              { key: 'preferred', value: data.selectedProviderId ?? '— (system default)' },
              { key: 'model', value: data.selectedModelId ?? '—' },
              { key: 'total', value: `${data.providers?.length ?? 0} providers` },
            ]}
          />
          {data.availableProviders && data.availableProviders.length > 0 && (
            <YStack gap={3} marginTop={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                available
              </Text>
              <PillList items={data.availableProviders} max={8} />
            </YStack>
          )}
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <EntityCard
        leading={<Avatar name={name} size={22} />}
        title={name}
        subtitle={shortId(data.agentId ?? (input?.agentId as string | undefined))}
        meta={<ActionBadge verb="deleted" />}
      />
    </ToolShell>
  );
}

interface SetProvidersResult {
  agentId?: string;
  agentName?: string;
  availableProviders?: string[];
}

function SetAgentProvidersRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SetProvidersResult;
  const providers = data.availableProviders ?? [];

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <ResourceCard
        leading={<Avatar name={data.agentName} size={28} />}
        title={data.agentName ?? shortId(data.agentId)}
        subtitle={t('mca.terosCore.providersUpdated')}
        verb="updated"
      >
        {providers.length === 0 ? (
          <Text color={c.text3} fontSize={10} fontFamily="$mono">
            (cleared — agent will have no providers until set again)
          </Text>
        ) : (
          <PillList items={providers} max={8} />
        )}
      </ResourceCard>
    </ToolShell>
  );
}

interface SetPreferredProviderResult {
  agentId?: string;
  agentName?: string;
  selectedProviderId?: string | null;
}

function SetAgentPreferredProviderRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SetPreferredProviderResult;
  const selected = data.selectedProviderId ?? (input?.providerId as string | undefined) ?? null;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <ResourceCard
        leading={<Avatar name={data.agentName} size={28} />}
        title={data.agentName ?? shortId(data.agentId)}
        subtitle="Preferred provider"
        verb="updated"
      >
        {selected ? (
          <IconChip text={selected} accent={colors.indigo} outline />
        ) : (
          <Text color={c.text3} fontSize={10} fontFamily="$mono">
            (cleared — system will auto-pick)
          </Text>
        )}
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {agents.length === 0 ? (
        <Empty message="No agents have access to this app" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {agents.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.agentId}
                leading={<Avatar name={a.agentFullName ?? a.agentName} size={22} />}
                title={a.agentFullName ?? a.agentName ?? a.agentId}
                subtitle={a.grantedBy ? `granted by ${shortId(a.grantedBy, 8)}` : shortId(a.agentId)}
                meta={<Cell text={formatDate(a.grantedAt)} muted />}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

// ── show-app-auth: inline auth widget ──────────────────────────────────────

interface ShowAppAuthInfo {
  status?: 'ready' | 'needs_user_auth' | 'expired' | 'error' | 'needs_system_setup' | 'not_required';
  authType?: 'none' | 'agent' | 'apikey' | 'oauth2' | 'github-app';
  message?: string;
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
  const storedName = useNavbarStore((s) =>
    appId ? s.apps.find((a) => a.appId === appId)?.name : undefined,
  );
  return parsedName ?? storedName;
}

/** "gmail app auth" with a known name, plain "app auth" without. */
function appAuthLabel(appName: string | undefined): string {
  return appName ? `${appName} app auth` : 'app auth';
}

function AuthActionButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
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
        backgroundColor: 'rgba(94,106,210,0.14)',
        borderWidth: 1,
        borderColor: 'rgba(94,106,210,0.35)',
        opacity: disabled ? 0.5 : 1,
        alignSelf: 'stretch',
      }}
    >
      <Text fontSize={11} color="#a5b4fc" fontWeight="600">
        {label}
      </Text>
    </TouchableOpacity>
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
  // Target app icon (convention /static/mcas/<mcaId>/icon.png); fallback:
  // the core's icon (props.appIcon, the gear) and, with no URL at all, the
  // IconTile 2-letter label.
  const targetIcon = parsed?.mcaId
    ? `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ''}/static/mcas/${parsed.mcaId}/icon.png`
    : props.appIcon;

  const [liveAuth, setLiveAuth] = useState<ShowAppAuthInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
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

  const openAppWindow = () => {
    if (appId) useTilingStore.getState().openWindow('app', { appId });
  };

  const chip = auth?.status ? AUTH_STATUS_CHIP[auth.status] : undefined;
  const isOAuth = auth?.authType === 'oauth2' || auth?.authType === 'github-app';
  const needsAction = auth?.status !== 'ready' && auth?.status !== 'not_required';
  const connectLabel = auth?.status === 'expired' || auth?.status === 'error' ? 'Reconnect' : 'Connect';

  return (
    <ToolCallCard
      status={status}
      description={tenseByStatus(status, {
        future: `show ${appAuthLabel(appName)}`,
        present: `Showing ${appAuthLabel(appName)}`,
        // Deliberately imperative: the completed card is a call to action
        // for the user (connect), not a record of a past action.
        past: `Configure ${appAuthLabel(appName)}`,
      })}
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
          {needsAction && auth?.authType === 'apikey' && (
            <AuthActionButton label="Open app settings" onPress={openAppWindow} />
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
    ? `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ''}/static/mcas/${parsed.mcaId}/icon.png`
    : props.appIcon;
  const auth = parsed?.auth ?? null;
  const chip = auth?.status ? AUTH_STATUS_CHIP[auth.status] : undefined;

  return (
    <ToolCallCard
      status={status}
      description={tenseByStatus(status, {
        future: `check ${appAuthLabel(appName)}`,
        present: `Checking ${appAuthLabel(appName)}`,
        past: `Checked ${appAuthLabel(appName)}`,
      })}
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

function ListCatalogRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: catalog } = unwrapList<CatalogEntry>(parsed, 'catalog');

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {skillAgentDual(data, input, 'grant')}
    </ToolShell>
  );
}

function SkillRevokeAccessRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as SkillActionResult;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
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

  return (
    <ToolCallCard
      status={status}
      description={tenseByStatus(status, getTenseForms(toolName))}
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
            <SuccessBlock message={getToolLabel(toolName)} />
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
  'set-agent-providers': SetAgentProvidersRenderer,
  'set-agent-preferred-provider': SetAgentPreferredProviderRenderer,
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
  'list-apps': ListAppsRenderer,
  'get-app': GetAppRenderer,
  'install-app': InstallAppRenderer,
  'uninstall-app': UninstallAppRenderer,
  'rename-app': RenameAppRenderer,
  'check-app-auth': CheckAppAuthRenderer,
  'show-app-auth': ShowAppAuthRenderer,
  'list-app-access': AppAccessListRenderer,
  'grant-app-access': GrantAppAccessRenderer,
  'revoke-app-access': RevokeAppAccessRenderer,
  // Catalog / Providers
  'list-catalog': ListCatalogRenderer,
  'list-providers': ListProvidersRenderer,
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
