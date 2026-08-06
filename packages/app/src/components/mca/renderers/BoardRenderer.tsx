/**
 * mca.teros.board-{manager,runner} — Tool Call Renderer compartido.
 *
 * Un único renderer que sirve a ambos MCAs del dominio Board. Los dos tienen
 * mcaIds distintos pero comparten ~60% de shape (Task, Project, agents),
 * por eso se registra el mismo componente dos veces en registerMcas.ts.
 *
 * Cobertura 100%: cada tool tiene sub-renderer dedicado. El FallbackRenderer
 * es un warning visible (bug dev-only) — no debería dispararse en prod.
 *
 * Organización del archivo:
 *   1. Shared types (Task, Project, BoardAgent, …).
 *   2. Labels + helpers (humanize, StatusBadge, formatDate, unwrap, diffFields).
 *   3. ToolShell common card-shell.
 *   4. Common task rendering helpers (TaskRow, TaskDetail, ProgressNoteList).
 *   5. Sub-renderers agrupados por operación (list, get, create, update, state, …).
 *   6. Fallback.
 *   7. Registry + entry points (manager / runner).
 *
 * Principios (canónicos del catálogo, ver MCA-RENDERER-GUIDE.md):
 *   - Backend devuelve datos puros — la frase visible se compone aquí.
 *   - Un renderer por tool, sin mega-switches ni lógica inferida.
 *   - Primitivos antes que layout ad-hoc.
 *   - JsonPreview solo con `includeRaw=true` o en el fallback dev.
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
  Avatar,
  Badge,
  colors,
  useColors,
  DualEntity,
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
  TaskStatusBadge,
  tenseByStatus,
  ToolCallCard,
  truncate,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// 1. SHARED TYPES
// ============================================================================

interface Task {
  taskId: string;
  boardId?: string;
  columnId?: string;
  columnName?: string;
  columnSlug?: string;
  position?: number;
  title?: string;
  description?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  archived?: boolean;
  archiveNote?: string;
  tags?: string[];
  assignedAgentId?: string | null;
  assigneeName?: string;
  assigneeAvatarUrl?: string;
  channelId?: string;
  running?: boolean;
  stopRequested?: boolean;
  stopRequestedAt?: string;
  stopRequestedBy?: string;
  parentTaskId?: string | null;
  parentTaskTitle?: string;
  projectId?: string;
  projectName?: string;
  dependencies?: string[];
  progressNotes?: ProgressNote[];
  createdAt?: string;
  updatedAt?: string;
}

interface ProgressNote {
  text?: string;
  actor?: string;
  timestamp?: string;
}

interface Project {
  projectId: string;
  workspaceId?: string;
  name?: string;
  description?: string;
  context?: string;
  boardId?: string;
  status?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  taskCount?: number;
  activeAgentCount?: number;
}

interface BoardColumn {
  columnId: string;
  slug?: string;
  name?: string;
  position?: number;
}

interface Board {
  boardId?: string;
  projectId?: string;
  columns?: BoardColumn[];
}

interface ResolvedAgent {
  agentId?: string;
  name?: string;
  fullName?: string;
  role?: string;
  avatarUrl?: string;
  workspaceId?: string;
  capabilities?: string[];
}

interface BoardStatusAgent {
  agentId: string;
  agentName?: string;
  agentFullName?: string;
  agentAvatarUrl?: string;
  slots?: number;
  playEnabled?: boolean;
  activeSlots?: number;
  tasksInProgress?: number;
  tasksInReview?: number;
  tasksBlocked?: number;
  tasksToDo?: number;
}

interface AgentProjectRelationship {
  agentId: string;
  projectId: string;
  slots?: number;
  playEnabled?: boolean;
  activeSlots?: number;
}

interface BoardSubscription {
  subscriptionId: string;
  boardId?: string;
  boardName?: string;
  channelId?: string;
  agentId?: string;
  filter?: {
    agentIds?: string[];
    columnIds?: string[];
    tags?: string[];
    eventTypes?: string[];
    wakeUpOn?: string[];
  };
  createdAt?: string;
  updatedAt?: string;
}

interface HealthCheckResult {
  status?: 'ready' | 'not_ready' | 'degraded';
  version?: string;
  issues?: Array<{ code?: string; message?: string }>;
}

// ============================================================================
// 2. LABELS + HELPERS
// ============================================================================

const TOOL_LABELS: Record<string, string> = {
  // Board manager reads
  'get-project': 'Project detail',
  'list-projects': 'Projects',
  'get-task': 'Task detail',
  'list-tasks': 'Tasks',
  'list-board-agents': 'Board agents',
  'get-task-dependencies': 'Task dependencies',
  'get-board-status': 'Board status',
  'list-board-subscriptions': 'Board subscriptions',
  // Board manager writes
  'create-project': 'Create project',
  'create-task': 'Create task',
  'batch-create-tasks': 'Create tasks (batch)',
  'update-task': 'Update task',
  'update-project': 'Update project',
  'assign-task': 'Assign task',
  'move-task': 'Move task',
  'archive-task': 'Archive task',
  'start-task': 'Start task',
  'stop-task': 'Stop task',
  'delete-task': 'Delete task',
  'link-conversation': 'Link conversation',
  'add-progress-note': 'Progress note',
  'add-task-dependency': 'Add dependency',
  'remove-task-dependency': 'Remove dependency',
  'set-agent-slots': 'Agent slots',
  'set-agent-play': 'Agent autoplay',
  'subscribe-to-board': 'Subscribe board',
  'unsubscribe-from-board': 'Unsubscribe board',
  // Board runner
  'get-my-tasks': 'My tasks',
  'get-my-task': 'My active task',
  'complete-my-task': 'Complete task',
  'block-my-task': 'Block task',
  'cancel-my-task': 'Cancel task',
  // Health
  '-health-check': 'Health check',
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
 * Best-effort tense derivation from the canonical tool label (guide §2).
 * Same shape as TerosCoreRenderer.
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
 * Tools que no se pueden deshacer (guide §8 — binary).
 */
const IRREVERSIBLE_TOOLS = new Set<string>([
  'delete-task',
  'archive-task',
  'cancel-my-task',
  'remove-task-dependency',
  'unsubscribe-from-board',
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
): { items: T[]; nextCursor?: string; extra: Record<string, unknown> } {
  if (!parsed || typeof parsed !== 'object') return { items: [], extra: {} };
  const obj = parsed as Record<string, unknown>;
  const list = obj[wrapperKey];
  const items = Array.isArray(list) ? (list as T[]) : [];
  const cursor = typeof obj.nextCursor === 'string' ? obj.nextCursor : undefined;
  return { items, nextCursor: cursor, extra: obj };
}

function diffFields(input: Record<string, unknown> | undefined, keys: string[]): KeyValueRow[] {
  if (!input) return [];
  const out: KeyValueRow[] = [];
  for (const k of keys) {
    const v = input[k];
    if (v !== undefined && v !== null && v !== '') {
      const str =
        typeof v === 'string'
          ? truncate(v, 80)
          : typeof v === 'object'
            ? '(updated)'
            : String(v);
      out.push({ key: k, value: str });
    }
  }
  return out;
}

function priorityColor(p: Task["priority"], text3: string): string {
  if (p === 'urgent') return colors.red;
  if (p === 'high') return colors.amber;
  if (p === 'low') return text3;
  return colors.indigo;
}

function Cell({ text, muted = false }: { text: string; muted?: boolean }) {
  const c = useColors();
  return (
    <Text color={muted ? c.text3 : c.text} fontSize={10} numberOfLines={1}>
      {text}
    </Text>
  );
}

function NextCursorHint({ cursor }: { cursor?: string }) {
  const c = useColors();
  if (!cursor) return null;
  return (
    <Text color={c.text3} fontSize={9} fontFamily="$mono" marginTop={4}>
      more available · pass cursor="{truncate(cursor, 16)}"
    </Text>
  );
}

// ============================================================================
// 3. TOOLSHELL
// ============================================================================

/**
 * Card-shell estándar para los renderers BoardManager/BoardRunner.
 * Guide §7 DON'T: no añadir badge que duplique el status dot.
 * Description pasa por `tenseByStatus`. `irreversible` se deriva del
 * toolName via `IRREVERSIBLE_TOOLS`.
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
// 4. COMMON TASK RENDERING HELPERS
// ============================================================================

function taskTitle(t: Task): string {
  return t.title ?? t.taskId;
}

function taskLeadingAvatar(t: Task, size = 22): React.ReactNode {
  if (t.assigneeAvatarUrl || t.assigneeName) {
    return <Avatar src={t.assigneeAvatarUrl} name={t.assigneeName} size={size} />;
  }
  return <IconTile label="·" size={size} radius={4} />;
}

function taskSubtitle(t: Task): string | undefined {
  const parts: string[] = [];
  if (t.projectName) parts.push(t.projectName);
  if (t.assigneeName) parts.push(`@${t.assigneeName}`);
  if (!t.assigneeName && t.assignedAgentId) parts.push(`@${shortId(t.assignedAgentId, 8, 3)}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function TaskRow({ task }: { task: Task }) {
  const c = useColors();
  const meta = (
    <XStack gap={4} alignItems="center">
      {task.priority && (
        <IconChip text={task.priority} accent={priorityColor(task.priority, c.text3)} outline />
      )}
      <TaskStatusBadge
        slug={task.columnSlug}
        fallbackLabel={task.columnName}
        running={task.running}
        archived={task.archived}
      />
    </XStack>
  );
  return (
    <EntityRow
      leading={taskLeadingAvatar(task, 22)}
      title={taskTitle(task)}
      subtitle={taskSubtitle(task)}
      meta={meta}
    />
  );
}

function ProgressNoteList({ notes }: { notes?: ProgressNote[] }) {
  const c = useColors();
  if (!notes || notes.length === 0) return null;
  const recent = notes.slice(-5);
  return (
    <YStack gap={3} marginTop={4}>
      <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
        progress ({notes.length})
      </Text>
      {recent.map((n, i) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list within card
          key={i}
          gap={4}
          alignItems="flex-start"
        >
          <Text color={c.text3} fontSize={9} fontFamily="$mono">
            {formatDate(n.timestamp)}
          </Text>
          <Text color={c.text} fontSize={10} flex={1}>
            {truncate(n.text ?? '', 160)}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

function taskDetailRows(t: Task): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: 'taskId', value: shortId(t.taskId) },
    { key: 'project', value: t.projectName ?? shortId(t.projectId) },
    { key: 'column', value: t.columnName ?? t.columnSlug ?? '—' },
  ];
  if (t.priority) rows.push({ key: 'priority', value: t.priority });
  if (t.assigneeName || t.assignedAgentId)
    rows.push({ key: 'assignee', value: t.assigneeName ?? shortId(t.assignedAgentId) });
  if (t.parentTaskTitle || t.parentTaskId)
    rows.push({ key: 'parent', value: t.parentTaskTitle ?? shortId(t.parentTaskId) });
  if (t.channelId) rows.push({ key: 'channel', value: shortId(t.channelId) });
  if (t.stopRequested) rows.push({ key: 'stopRequested', value: 'true' });
  rows.push({ key: 'created', value: formatDate(t.createdAt) });
  rows.push({ key: 'updated', value: formatDate(t.updatedAt) });
  return rows;
}

function TaskDetail({ task }: { task: Task }) {
  const c = useColors();
  return (
    <ResourceCard
      leading={taskLeadingAvatar(task, 32)}
      title={taskTitle(task)}
      subtitle={taskSubtitle(task)}
      meta={
        <TaskStatusBadge
          slug={task.columnSlug}
          fallbackLabel={task.columnName}
          running={task.running}
          archived={task.archived}
        />
      }
    >
      <KeyValueGrid rows={taskDetailRows(task)} />
      {task.description && (
        <YStack gap={3} marginTop={4}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            description
          </Text>
          <Text color={c.text} fontSize={10}>
            {truncate(task.description, 240)}
          </Text>
        </YStack>
      )}
      {task.tags && task.tags.length > 0 && (
        <YStack gap={3} marginTop={4}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            tags
          </Text>
          <PillList items={task.tags} />
        </YStack>
      )}
      {task.dependencies && task.dependencies.length > 0 && (
        <YStack gap={3} marginTop={4}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            depends on ({task.dependencies.length})
          </Text>
          <PillList items={task.dependencies.map((id) => shortId(id, 10, 4))} />
        </YStack>
      )}
      <ProgressNoteList notes={task.progressNotes} />
    </ResourceCard>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — LIST
// ============================================================================

function ListTasksRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: tasks, nextCursor, extra } = unwrapList<Task>(parsed, 'tasks');
  const projectName = extra.projectName as string | undefined;

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {projectName && (
        <Text
          color={c.text2}
          fontSize={9}
          fontFamily="$mono"
          textTransform="uppercase"
          marginBottom={4}
        >
          project · {projectName}
        </Text>
      )}
      {tasks.length === 0 ? (
        <Empty message="No tasks" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {tasks.slice(0, MAX_ITEMS).map((t) => (
              <TaskRow key={t.taskId} task={t} />
            ))}
          </YStack>
        </ScrollView>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

function ListMyTasksRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  // Same shape as list-tasks (wrapped in `tasks`), no projectName header.
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: tasks, nextCursor } = unwrapList<Task>(parsed, 'tasks');

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {tasks.length === 0 ? (
        <Empty message="No assigned tasks" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {tasks.slice(0, MAX_ITEMS).map((t) => (
              <TaskRow key={t.taskId} task={t} />
            ))}
          </YStack>
        </ScrollView>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

function ListProjectsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: projects, nextCursor } = unwrapList<Project>(parsed, 'projects');

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {projects.length === 0 ? (
        <Empty message="No projects" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {projects.slice(0, MAX_ITEMS).map((p) => (
              <EntityRow
                key={p.projectId}
                leading={<IconTile label={(p.name ?? '·').slice(0, 1).toUpperCase()} size={22} radius={5} />}
                title={p.name ?? p.projectId}
                subtitle={p.description ? truncate(p.description, 80) : undefined}
                meta={
                  <XStack gap={4}>
                    {typeof p.taskCount === 'number' && (
                      <IconChip text={`${p.taskCount} tasks`} accent={colors.indigo} outline />
                    )}
                    {typeof p.activeAgentCount === 'number' && p.activeAgentCount > 0 && (
                      <IconChip
                        text={`${p.activeAgentCount} agents`}
                        accent={colors.indigo}
                        outline
                      />
                    )}
                    {p.status === 'archived' && <Badge text="archived" variant="gray" />}
                  </XStack>
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

function ListBoardAgentsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: agents, nextCursor } = unwrapList<ResolvedAgent>(parsed, 'agents');

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {agents.length === 0 ? (
        <Empty message="No board agents" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack>
            {agents.slice(0, MAX_ITEMS).map((a) => (
              <EntityRow
                key={a.agentId ?? a.name}
                leading={<Avatar src={a.avatarUrl} name={a.fullName ?? a.name} size={22} />}
                title={a.fullName ?? a.name ?? a.agentId ?? '—'}
                subtitle={a.role}
                meta={
                  a.capabilities && a.capabilities.length > 0 ? (
                    <PillList items={a.capabilities} />
                  ) : undefined
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

function ListBoardSubscriptionsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: subs, nextCursor } = unwrapList<BoardSubscription>(parsed, 'subscriptions');

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {subs.length === 0 ? (
        <Empty message="No active subscriptions" />
      ) : (
        <YStack gap={3}>
          {subs.map((s) => {
            const filterPills: string[] = [];
            if (s.filter?.columnIds?.length) filterPills.push(`cols:${s.filter.columnIds.length}`);
            if (s.filter?.agentIds?.length) filterPills.push(`agents:${s.filter.agentIds.length}`);
            if (s.filter?.tags?.length) filterPills.push(`tags:${s.filter.tags.length}`);
            if (s.filter?.eventTypes?.length)
              filterPills.push(`events:${s.filter.eventTypes.length}`);
            return (
              <EntityRow
                key={s.subscriptionId}
                leading={<IconTile label="↯" size={22} radius={5} accent={colors.indigo} />}
                title={s.boardName ?? shortId(s.boardId)}
                subtitle={`sub ${shortId(s.subscriptionId, 8, 3)}`}
                meta={filterPills.length > 0 ? <PillList items={filterPills} /> : undefined}
              />
            );
          })}
        </YStack>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

function GetTaskDependenciesRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: deps, nextCursor } = unwrapList<Task>(parsed, 'dependencies');
  const taskId = (parsed as { taskId?: string })?.taskId ?? (input?.taskId as string | undefined);

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {taskId && (
        <Text
          color={c.text2}
          fontSize={9}
          fontFamily="$mono"
          textTransform="uppercase"
          marginBottom={4}
        >
          task · {shortId(taskId)}
        </Text>
      )}
      {deps.length === 0 ? (
        <Empty message="No dependencies" />
      ) : (
        <YStack>
          {deps.slice(0, MAX_ITEMS).map((d) => (
            <EntityRow
              key={d.taskId}
              leading={<IconTile label="⟵" size={22} radius={5} />}
              title={d.title ?? shortId(d.taskId)}
              subtitle={d.columnSlug ?? d.columnName}
              meta={
                <XStack gap={4}>
                  {d.priority && (
                    <IconChip text={d.priority} accent={priorityColor(d.priority, c.text3)} outline />
                  )}
                  <TaskStatusBadge
                    slug={d.columnSlug}
                    fallbackLabel={d.columnName}
                    archived={d.archived}
                  />
                </XStack>
              }
            />
          ))}
        </YStack>
      )}
      <NextCursorHint cursor={nextCursor} />
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — GET (single entity)
// ============================================================================

function GetTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const subTasks = Array.isArray((parsed as { subTasks?: Task[] })?.subTasks)
    ? ((parsed as { subTasks: Task[] }).subTasks as Task[])
    : [];

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {task && <TaskDetail task={task} />}
      {subTasks.length > 0 && (
        <YStack gap={3} marginTop={6}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            sub-tasks ({subTasks.length})
          </Text>
          {subTasks.map((st) => (
            <TaskRow key={st.taskId} task={st} />
          ))}
        </YStack>
      )}
    </ToolShell>
  );
}

function GetMyTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task ? (
        <TaskDetail task={task} />
      ) : (
        <Empty message="No active task linked to this conversation" />
      )}
    </ToolShell>
  );
}

function GetProjectRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const project = unwrap<Project>(parsed, 'project', 'projectId');
  const board = (parsed as { board?: Board })?.board;

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {project && (
        <ResourceCard
          leading={
            <IconTile
              label={(project.name ?? '·').slice(0, 1).toUpperCase()}
              size={32}
              radius={6}
            />
          }
          title={project.name ?? project.projectId}
          subtitle={project.description ? truncate(project.description, 80) : undefined}
          meta={project.status === 'archived' ? <Badge text="archived" variant="gray" /> : undefined}
        >
          <KeyValueGrid
            rows={[
              { key: 'projectId', value: shortId(project.projectId) },
              { key: 'workspace', value: shortId(project.workspaceId) },
              { key: 'board', value: shortId(project.boardId) },
              { key: 'created', value: formatDate(project.createdAt) },
              { key: 'updated', value: formatDate(project.updatedAt) },
            ]}
          />
          {project.context && (
            <YStack gap={3} marginTop={4}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                context (injected in system prompts)
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(project.context, 240)}
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
      {board?.columns && board.columns.length > 0 && (
        <YStack gap={3} marginTop={6}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            columns ({board.columns.length})
          </Text>
          <XStack gap={4} flexWrap="wrap">
            {board.columns.map((c) => (
              <TaskStatusBadge key={c.columnId} slug={c.slug} fallbackLabel={c.name} />
            ))}
          </XStack>
        </YStack>
      )}
    </ToolShell>
  );
}

function GetBoardStatusRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed as {
    boardId?: string;
    boardName?: string;
    agents?: BoardStatusAgent[];
    summary?: {
      total?: number;
      byColumn?: Record<string, number>;
      blockedTasks?: Task[];
    };
  }) ?? {};

  const summary = data.summary ?? {};
  const summaryRows: KeyValueRow[] = [];
  if (typeof summary.total === 'number') summaryRows.push({ key: 'total', value: String(summary.total) });
  if (summary.byColumn) {
    for (const [slug, count] of Object.entries(summary.byColumn)) {
      summaryRows.push({ key: slug, value: String(count) });
    }
  }

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <ResourceCard
        leading={<IconTile label="▣" size={32} radius={6} />}
        title={data.boardName ?? shortId(data.boardId)}
        subtitle="board status"
      >
        {summaryRows.length > 0 && <KeyValueGrid rows={summaryRows} />}
      </ResourceCard>
      {data.agents && data.agents.length > 0 && (
        <YStack gap={3} marginTop={6}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            agents ({data.agents.length})
          </Text>
          {data.agents.map((a) => {
            const parts: string[] = [];
            if (typeof a.activeSlots === 'number' && typeof a.slots === 'number')
              parts.push(`${a.activeSlots}/${a.slots} slots`);
            if (a.playEnabled) parts.push('play ▶');
            if (typeof a.tasksInProgress === 'number') parts.push(`${a.tasksInProgress} active`);
            if (typeof a.tasksInReview === 'number') parts.push(`${a.tasksInReview} review`);
            if (typeof a.tasksBlocked === 'number' && a.tasksBlocked > 0)
              parts.push(`${a.tasksBlocked} blocked`);
            return (
              <EntityRow
                key={a.agentId}
                leading={
                  <Avatar
                    src={a.agentAvatarUrl}
                    name={a.agentFullName ?? a.agentName}
                    size={22}
                  />
                }
                title={a.agentFullName ?? a.agentName ?? a.agentId}
                subtitle={parts.join(' · ')}
              />
            );
          })}
        </YStack>
      )}
      {summary.blockedTasks && summary.blockedTasks.length > 0 && (
        <YStack gap={3} marginTop={6}>
          <Text color={colors.red} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            blocked tasks ({summary.blockedTasks.length})
          </Text>
          {summary.blockedTasks.map((t) => (
            <TaskRow key={t.taskId} task={t} />
          ))}
        </YStack>
      )}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — CREATE
// ============================================================================

function CreateProjectRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const project = unwrap<Project>(parsed, 'project', 'projectId');

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {project && (
        <ResourceCard
          leading={
            <IconTile label={(project.name ?? '·').slice(0, 1).toUpperCase()} size={32} radius={6} />
          }
          title={project.name ?? project.projectId}
          subtitle={project.description ? truncate(project.description, 80) : undefined}
          verb="created"
        >
          <KeyValueGrid
            rows={[
              { key: 'projectId', value: shortId(project.projectId) },
              { key: 'workspace', value: shortId(project.workspaceId) },
              { key: 'board', value: shortId(project.boardId) },
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function CreateTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="created"
          meta={
            <TaskStatusBadge
              slug={task.columnSlug}
              fallbackLabel={task.columnName}
              archived={task.archived}
            />
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'taskId', value: shortId(task.taskId) },
              { key: 'priority', value: task.priority ?? '—' },
              ...(task.tags && task.tags.length > 0
                ? [{ key: 'tags', value: task.tags.join(', ') }]
                : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function BatchCreateTasksRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed as { projectId?: string; tasks?: Task[]; count?: number }) ?? {};
  const tasks = data.tasks ?? [];

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      <XStack gap={4} alignItems="center" marginBottom={4}>
        <ActionBadge verb="created" />
        <Text color={c.text} fontSize={10} fontFamily="$mono">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </Text>
        {data.projectId && (
          <Text color={c.text3} fontSize={9} fontFamily="$mono">
            · project {shortId(data.projectId)}
          </Text>
        )}
      </XStack>
      <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
        <YStack>
          {tasks.slice(0, MAX_ITEMS).map((t) => (
            <TaskRow key={t.taskId} task={t} />
          ))}
        </YStack>
      </ScrollView>
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — UPDATE
// ============================================================================

function UpdateTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const changes = diffFields(input, ['title', 'description', 'priority', 'tags']);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="updated"
          meta={
            <TaskStatusBadge
              slug={task.columnSlug}
              fallbackLabel={task.columnName}
              running={task.running}
              archived={task.archived}
            />
          }
        >
          {changes.length > 0 ? (
            <KeyValueGrid rows={changes} />
          ) : (
            <Text color={c.text3} fontSize={10}>
              No visible changes
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function UpdateProjectRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const project = unwrap<Project>(parsed, 'project', 'projectId');
  const changes = diffFields(input, ['name', 'description', 'context']);

  return (
    <ToolShell
      toolName={toolName}
      status={status}
      error={error}
     
    >
      {project && (
        <ResourceCard
          leading={
            <IconTile label={(project.name ?? '·').slice(0, 1).toUpperCase()} size={32} radius={6} />
          }
          title={project.name ?? project.projectId}
          subtitle={project.description ? truncate(project.description, 80) : undefined}
          verb="updated"
        >
          {changes.length > 0 ? (
            <KeyValueGrid rows={changes} />
          ) : (
            <Text color={c.text3} fontSize={10}>
              No visible changes
            </Text>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function AssignTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const isUnassign = !input?.agentId;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task &&
        (isUnassign ? (
          <EntityCard
            leading={<IconTile label="—" size={22} radius={5} />}
            title={taskTitle(task)}
            subtitle="unassigned"
            meta={<ActionBadge verb="updated" />}
          />
        ) : (
          <DualEntity
            left={{
              visual: <Avatar name={task.assigneeName ?? shortId(task.assignedAgentId)} size={24} />,
              title: task.assigneeName ?? shortId(task.assignedAgentId),
              subtitle: 'agent',
            }}
            right={{
              visual: taskLeadingAvatar(task, 24),
              title: taskTitle(task),
              subtitle: task.columnSlug ?? task.columnName,
            }}
            action="add-member"
            meta="assigned"
          />
        ))}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — STATE TRANSITIONS
// ============================================================================

function MoveTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="updated"
          meta={
            <TaskStatusBadge
              slug={task.columnSlug}
              fallbackLabel={task.columnName}
              running={task.running}
            />
          }
        />
      )}
    </ToolShell>
  );
}

function StartTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const channelId = (parsed as { channelId?: string })?.channelId;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="created"
          meta={<TaskStatusBadge slug={task.columnSlug ?? 'in_progress'} running={true} />}
        >
          <KeyValueGrid
            rows={[
              { key: 'taskId', value: shortId(task.taskId) },
              ...(channelId ? [{ key: 'channel', value: shortId(channelId) }] : []),
              ...(task.assigneeName || task.assignedAgentId
                ? [{ key: 'assignee', value: task.assigneeName ?? shortId(task.assignedAgentId) }]
                : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function StopTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed as { taskId?: string; stopRequested?: boolean; reason?: string }) ?? {};
  const taskId = data.taskId ?? (input?.taskId as string | undefined);
  const reason = data.reason ?? (input?.reason as string | undefined);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <EntityCard
        leading={<IconTile label="⏸" size={22} radius={5} accent={colors.amber} />}
        title={shortId(taskId)}
        subtitle={reason ? truncate(reason, 80) : 'stop requested (cooperative)'}
        meta={<Badge text="stop requested" variant="warning" />}
      />
    </ToolShell>
  );
}

function ArchiveTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const isArchive = input?.archived === true;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <EntityCard
          leading={taskLeadingAvatar(task, 22)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          meta={<ActionBadge verb={isArchive ? 'archived' : 'updated'} />}
        />
      )}
    </ToolShell>
  );
}

function DeleteTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = (parsed as { taskId?: string; deleted?: boolean }) ?? {};
  const taskId = data.taskId ?? (input?.taskId as string | undefined);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <EntityCard
        leading={<IconTile label="×" size={22} radius={5} accent={colors.red} />}
        title={shortId(taskId)}
        subtitle="permanently deleted"
        meta={<ActionBadge verb="deleted" />}
      />
    </ToolShell>
  );
}

function LinkConversationRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const channelId = (input?.channelId as string | undefined) ?? task?.channelId;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <DualEntity
          left={{
            visual: <IconTile label="💬" size={24} radius={5} />,
            title: shortId(channelId),
            subtitle: 'conversation',
          }}
          right={{
            visual: taskLeadingAvatar(task, 24),
            title: taskTitle(task),
            subtitle: task.columnSlug ?? task.columnName,
          }}
          action="transfer"
          meta="linked"
        />
      )}
    </ToolShell>
  );
}

// Runner state transitions
function CompleteMyTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="updated"
          meta={<TaskStatusBadge slug={task.columnSlug ?? 'review'} />}
        />
      )}
    </ToolShell>
  );
}

function BlockMyTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const reason = (input?.reason as string | undefined) ?? '';

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="updated"
          meta={<TaskStatusBadge slug={task.columnSlug ?? 'blocked'} />}
        >
          {reason && (
            <YStack gap={3} marginTop={4}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                reason
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(reason, 240)}
              </Text>
            </YStack>
          )}
          <ProgressNoteList notes={task.progressNotes} />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function CancelMyTaskRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const reason = (input?.reason as string | undefined) ?? '';

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <ResourceCard
          leading={taskLeadingAvatar(task, 32)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          verb="archived"
          meta={<TaskStatusBadge archived={true} />}
        >
          {reason && (
            <YStack gap={3} marginTop={4}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                reason
              </Text>
              <Text color={c.text} fontSize={10}>
                {truncate(reason, 240)}
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — DEPENDENCIES
// ============================================================================

function AddTaskDependencyRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const dependsOnTaskId = input?.dependsOnTaskId as string | undefined;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <DualEntity
          left={{
            visual: taskLeadingAvatar(task, 24),
            title: taskTitle(task),
            subtitle: 'dependent',
          }}
          right={{
            visual: <IconTile label="⟵" size={24} radius={5} />,
            title: shortId(dependsOnTaskId),
            subtitle: 'must complete first',
          }}
          action="grant"
          meta="depends on"
        />
      )}
    </ToolShell>
  );
}

function RemoveTaskDependencyRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const dependsOnTaskId = input?.dependsOnTaskId as string | undefined;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <DualEntity
          left={{
            visual: taskLeadingAvatar(task, 24),
            title: taskTitle(task),
            subtitle: 'dependent',
          }}
          right={{
            visual: <IconTile label="⟵" size={24} radius={5} />,
            title: shortId(dependsOnTaskId),
            subtitle: 'no longer blocks',
          }}
          action="revoke"
          meta="removed"
        />
      )}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — PROGRESS NOTES
// ============================================================================

function AddProgressNoteRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const task = unwrap<Task>(parsed, 'task', 'taskId');
  const text = input?.text as string | undefined;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {task && (
        <EntityCard
          leading={taskLeadingAvatar(task, 22)}
          title={taskTitle(task)}
          subtitle={taskSubtitle(task)}
          meta={<ActionBadge verb="updated" />}
        >
          {text && (
            <YStack
              gap={3}
              marginTop={4}
              padding={6}
              backgroundColor={c.bgInner}
              borderRadius={4}
              borderLeftWidth={2}
              borderLeftColor={colors.indigo}
            >
              <Text color={c.text} fontSize={10}>
                {truncate(text, 240)}
              </Text>
            </YStack>
          )}
        </EntityCard>
      )}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — AUTOPLAY
// ============================================================================

function agentLabel(relationship: AgentProjectRelationship, input?: Record<string, unknown>): string {
  return shortId(relationship.agentId ?? (input?.agentId as string | undefined));
}

function SetAgentSlotsRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const rel = unwrap<AgentProjectRelationship>(parsed, 'relationship', 'agentId');
  const requestedSlots = input?.slots as number | undefined;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {rel && (
        <ResourceCard
          leading={<Avatar name={agentLabel(rel, input)} size={32} />}
          title={agentLabel(rel, input)}
          subtitle={`project ${shortId(rel.projectId)}`}
          verb="updated"
          meta={
            <IconChip
              text={`${rel.slots ?? requestedSlots ?? 0} slots`}
              accent={(rel.slots ?? requestedSlots ?? 0) > 0 ? colors.indigo : c.text3}
              outline
            />
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'slots', value: String(rel.slots ?? requestedSlots ?? 0) },
              { key: 'playEnabled', value: rel.playEnabled ? 'true' : 'false' },
              ...(typeof rel.activeSlots === 'number'
                ? [{ key: 'activeSlots', value: String(rel.activeSlots) }]
                : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

function SetAgentPlayRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const rel = unwrap<AgentProjectRelationship>(parsed, 'relationship', 'agentId');
  const requestedEnabled = input?.enabled as boolean | undefined;
  const enabled = rel?.playEnabled ?? requestedEnabled ?? false;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {rel && (
        <ResourceCard
          leading={<Avatar name={agentLabel(rel, input)} size={32} />}
          title={agentLabel(rel, input)}
          subtitle={`project ${shortId(rel.projectId)}`}
          verb="updated"
          meta={
            <Badge text={enabled ? 'play ▶' : 'paused ⏸'} variant={enabled ? 'success' : 'gray'} />
          }
        >
          <KeyValueGrid
            rows={[
              { key: 'playEnabled', value: enabled ? 'true' : 'false' },
              ...(typeof rel.slots === 'number'
                ? [{ key: 'slots', value: String(rel.slots) }]
                : []),
            ]}
          />
        </ResourceCard>
      )}
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — SUBSCRIPTIONS
// ============================================================================

function SubscribeToBoardRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const sub = unwrap<BoardSubscription>(parsed, 'subscription', 'subscriptionId');
  const boardId = sub?.boardId ?? (input?.boardId as string | undefined);

  const filterPills: string[] = [];
  const filter = sub?.filter;
  if (filter?.columnIds?.length) filterPills.push(`cols:${filter.columnIds.length}`);
  if (filter?.agentIds?.length) filterPills.push(`agents:${filter.agentIds.length}`);
  if (filter?.tags?.length) filterPills.push(`tags:${filter.tags.length}`);
  if (filter?.eventTypes?.length) filterPills.push(`events:${filter.eventTypes.length}`);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <DualEntity
        left={{
          visual: <IconTile label="💬" size={24} radius={5} />,
          title: 'this conversation',
          subtitle: 'subscriber',
        }}
        right={{
          visual: <IconTile label="↯" size={24} radius={5} accent={colors.indigo} />,
          title: sub?.boardName ?? shortId(boardId),
          subtitle: 'board',
        }}
        action="grant"
        meta={sub ? `sub ${shortId(sub.subscriptionId, 8, 3)}` : undefined}
      />
      {filterPills.length > 0 && (
        <YStack gap={3} marginTop={4}>
          <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
            filter
          </Text>
          <PillList items={filterPills} />
        </YStack>
      )}
    </ToolShell>
  );
}

function UnsubscribeFromBoardRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const boardId =
    (parsed as { boardId?: string })?.boardId ?? (input?.boardId as string | undefined);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <DualEntity
        left={{
          visual: <IconTile label="💬" size={24} radius={5} />,
          title: 'this conversation',
          subtitle: 'subscriber',
        }}
        right={{
          visual: <IconTile label="↯" size={24} radius={5} />,
          title: shortId(boardId),
          subtitle: 'board',
        }}
        action="revoke"
        meta="unsubscribed"
      />
    </ToolShell>
  );
}

// ============================================================================
// 5. SUB-RENDERERS — HEALTH CHECK
// ============================================================================

function HealthCheckRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const raw = output ? parseOutput<unknown>(output) : null;
  const parsed: HealthCheckResult | null =
    raw && typeof raw === 'object' ? (raw as HealthCheckResult) : null;
  const healthStatus = parsed?.status ?? 'not_ready';
  const ok = healthStatus === 'ready';

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <EntityCard
        leading={<IconTile label={ok ? '✓' : '!'} size={22} radius={5} accent={ok ? colors.green : colors.red} />}
        title={ok ? 'ready' : healthStatus}
        subtitle={parsed?.version ? `v${parsed.version}` : undefined}
        meta={<Badge text={healthStatus} variant={ok ? 'success' : healthStatus === 'degraded' ? 'warning' : 'error'} />}
      >
        {parsed?.issues && parsed.issues.length > 0 && (
          <YStack gap={3} marginTop={4}>
            {parsed.issues.map((issue, i) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: short list, stable during render
                key={i}
                color={colors.red}
                fontSize={10}
              >
                {issue.code ? `[${issue.code}] ` : ''}
                {issue.message ?? ''}
              </Text>
            ))}
          </YStack>
        )}
      </EntityCard>
    </ToolShell>
  );
}

// ============================================================================
// 6. FALLBACK — señal de bug en dev. No debería dispararse con cobertura 100%.
// ============================================================================

function FallbackRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, duration } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      <YStack gap={3}>
        <Text color={colors.red} fontSize={10} fontFamily="$mono">
          [dev] No dedicated renderer for tool: {getShortToolName(toolName)}
        </Text>
        {parsed != null && <JsonPreview value={parsed} />}
      </YStack>
    </ToolShell>
  );
}

// ============================================================================
// 7. REGISTRY + ENTRY POINTS
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Health
  '-health-check': HealthCheckRenderer,
  // Board manager reads
  'get-project': GetProjectRenderer,
  'list-projects': ListProjectsRenderer,
  'get-task': GetTaskRenderer,
  'list-tasks': ListTasksRenderer,
  'list-board-agents': ListBoardAgentsRenderer,
  'get-task-dependencies': GetTaskDependenciesRenderer,
  'get-board-status': GetBoardStatusRenderer,
  'list-board-subscriptions': ListBoardSubscriptionsRenderer,
  // Board manager writes
  'create-project': CreateProjectRenderer,
  'create-task': CreateTaskRenderer,
  'batch-create-tasks': BatchCreateTasksRenderer,
  'update-task': UpdateTaskRenderer,
  'update-project': UpdateProjectRenderer,
  'assign-task': AssignTaskRenderer,
  'move-task': MoveTaskRenderer,
  'archive-task': ArchiveTaskRenderer,
  'start-task': StartTaskRenderer,
  'stop-task': StopTaskRenderer,
  'delete-task': DeleteTaskRenderer,
  'link-conversation': LinkConversationRenderer,
  'add-progress-note': AddProgressNoteRenderer,
  'add-task-dependency': AddTaskDependencyRenderer,
  'remove-task-dependency': RemoveTaskDependencyRenderer,
  'set-agent-slots': SetAgentSlotsRenderer,
  'set-agent-play': SetAgentPlayRenderer,
  'subscribe-to-board': SubscribeToBoardRenderer,
  'unsubscribe-from-board': UnsubscribeFromBoardRenderer,
  // Board runner
  'get-my-tasks': ListMyTasksRenderer,
  'get-my-task': GetMyTaskRenderer,
  'complete-my-task': CompleteMyTaskRenderer,
  'block-my-task': BlockMyTaskRenderer,
  'cancel-my-task': CancelMyTaskRenderer,
};

function BoardRendererBase(props: ToolCallRendererProps) {
  const c = useColors();
  const short = getShortToolName(props.toolName);
  const Renderer = RENDERERS[short] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

// El mismo componente se registra dos veces en registerMcas.ts con mcaIds
// distintos (`mca.teros.board-manager` y `mca.teros.board-runner`). El 60%
// de los sub-renderers se comparten, por eso un único componente cubre ambos.
export const BoardToolCallRenderer = withPermissionSupport(BoardRendererBase);
export default BoardToolCallRenderer;

// Re-export para tests internos: permite verificar cobertura del registry.
export const __TEST_RENDERERS = RENDERERS;
