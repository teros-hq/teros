/**
 * mca.teros.todo-list — Tool Call Renderer (v2 — Workflowy-style)
 *
 * Design: task state dot (planning · pending · working · blocked · review ·
 * done, the To Do window's colours) or a folder glyph for groups — the old
 * empty / ✓ green / ✕ red checkbox remains only for the legacy shape;
 * chevron outside the checkbox, collapsible tree, Spanish labels,
 * no technical IDs visible, instructions in violet block, log as "historial".
 *
 * Tools covered:
 *   - add-node        → "Node added: ParentTitle → ChildTitle" card
 *   - get-node        → Full node detail (instructions + log)
 *   - get-tree        → Nested collapsible tree
 *   - update-node     → Node updated card (before→after diff)
 *   - toggle-complete → Completion toggled card
 *   - toggle-collapse → Collapse toggled card
 *   - move-node       → Node moved card
 *   - delete-node     → Node deleted card
 *   - search-nodes    → Search results list
 *   - add-log-entry   → Log entry added card
 *   - -health-check   → Health check
 *
 * All sub-renderer titles include contextual node info (title, parent,
 * query, state) via contextualDescription, instead of generic labels.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { Check, ChevronRight, X } from '../primitives';
import { MarkdownContent } from '../../chat/bubbles/MarkdownContent';

import {
  Badge,
  colors,
  useColors,
  Empty,
  ErrorBlock,
  getShortToolName,
  JsonPreview,
  type KeyValueRow,
  KeyValueGrid,
  MAX_ITEMS,
  parseOutput,
  ToolCallCard,
  truncate,
} from '../primitives';
import { Ph } from '../../ui/ds';
import { useTd } from '../../../windows/TodoWindow/ui/tokens';
import { Dot } from '../../../windows/TodoWindow/ui/kit';
import { usePeople } from '../../../windows/TodoWindow/data/usePeople';
import { useWorkspaceStore } from '../../../store/workspaceStore';
import { useTranslation } from 'react-i18next';
import { installTodoFx } from '../../../windows/TodoWindow/ui/todoFx';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// 1. SHARED TYPES
// ============================================================================

type TaskState = 'planning' | 'pending' | 'working' | 'blocked' | 'review' | 'done';

interface TodoNode {
  nodeId: string;
  parentId: string | null;
  kind?: 'group' | 'task';
  state?: TaskState | null;
  assignee?: { kind: 'agent' | 'user'; id: string } | null;
  text?: string;
  description?: string;
  instructions?: string;
  completed?: boolean;
  collapsed?: boolean;
  position?: number;
  childCount?: number;
  completedChildren?: number;
  children?: TodoNode[];
  log?: LogEntry[];
  createdAt?: number;
  updatedAt?: number;
}

interface LogEntry {
  timestamp: number;
  text: string;
}

interface SearchResult {
  nodeId: string;
  kind?: 'group' | 'task';
  state?: TaskState | null;
  text?: string;
  description?: string;
  completed?: boolean;
  path?: string;
  updatedAt?: number;
}

// ============================================================================
// 2. LABELS + HELPERS
// ============================================================================

const TOOL_LABELS: Record<string, string> = {
  'add-node': 'Add node',
  'get-node': 'Node detail',
  'get-tree': 'Tree',
  'update-node': 'Update node',
  'toggle-complete': 'Toggle complete',
  'toggle-collapse': 'Toggle collapse',
  'move-node': 'Move node',
  'delete-node': 'Delete node',
  'search-nodes': 'Search nodes',
  'add-log-entry': 'Log entry',
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

function getToolDescription(toolName: string): string {
  return getToolLabel(toolName);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Static contextual description from a verb + contextual detail.
 * e.g. ("get", "\"Buy milk\"") → "get \"Buy milk\""
 */
function contextualDescription(verb: string, detail?: string | null): string {
  const label = verb.charAt(0).toUpperCase() + verb.slice(1);
  if (!detail) return `${label} node`;
  const truncated = truncate(detail, 40);
  return `${label} ${truncated}`;
}

/** Extract a short node title from a TodoNode or partial object — never its id. */
function nodeTitle(node: { text?: string; nodeId?: string } | null | undefined): string {
  return node?.text ?? 'node';
}

const IRREVERSIBLE_TOOLS = new Set<string>(['delete-node']);

function isIrreversibleTool(toolName: string): boolean {
  return IRREVERSIBLE_TOOLS.has(getShortToolName(toolName));
}

function relativeTime(ts: number | undefined): string {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days}d`;
  return new Date(ts).toISOString().slice(0, 10);
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

// ============================================================================
// 3. TOOLSHELL
// ============================================================================

function ToolShell({
  toolName,
  status,
  error,
  appIcon,
  description,
  children,
}: {
  toolName: string;
  status: ToolCallRendererProps['status'];
  error?: string;
  appIcon?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <ToolCallCard
      status={status}
      description={description ?? getToolDescription(toolName)}
      iconUri={appIcon}
      defaultExpanded={false}
      irreversible={isIrreversibleTool(toolName)}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && children}
    </ToolCallCard>
  );
}

// ============================================================================
// 4. CHECKBOX + CHEVRON (SVG-style using Phosphor)
// ============================================================================

/** Checkbox — 3 states: empty (gray border), done (green ✓), cancelled (red ✕) */
function Checkbox({
  state,
  size = 18,
}: {
  state: 'empty' | 'done' | 'cancelled';
  size?: number;
}): React.ReactNode {
  const c = useColors();
  const iconSize = Math.round(size * 0.8);

  if (state === 'done') {
    return (
      <XStack
        width={size}
        height={size}
        borderRadius={5}
        borderWidth={1.5}
        borderColor={colors.green}
        backgroundColor={colors.greenGlow}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        <Check size={iconSize} color={colors.green} weight="bold" />
      </XStack>
    );
  }

  if (state === 'cancelled') {
    return (
      <XStack
        width={size}
        height={size}
        borderRadius={5}
        borderWidth={1.5}
        borderColor={colors.red}
        backgroundColor="rgba(239,68,68,0.12)"
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        <X size={iconSize} color={colors.red} weight="bold" />
      </XStack>
    );
  }

  // empty
  return (
    <XStack
      width={size}
      height={size}
      borderRadius={5}
      borderWidth={1.5}
      borderColor={c.text3}
      flexShrink={0}
    />
  );
}

/** The node's state (legacy nodes without `state` read from `completed`). */
function stateOfNode(n: { kind?: string; state?: TaskState | null; completed?: boolean }): TaskState | null {
  if (n.kind === 'group') return null;
  return n.state ?? (n.completed ? 'done' : 'pending');
}

/** State mark — the To Do's 8 px state dot (theme tokens), or a folder for a group. */
function StateMark({ node, size = 18 }: { node: { kind?: string; state?: TaskState | null; completed?: boolean }; size?: number }): React.ReactNode {
  const td = useTd();
  installTodoFx();
  const state = stateOfNode(node);
  return (
    <XStack width={size} height={size} alignItems="center" justifyContent="center" flexShrink={0}>
      {state ? (
        <Dot state={state} />
      ) : (
        <Ph name="folder-simple" size={14} color={td.text3} />
      )}
    </XStack>
  );
}

/** "Assigned to X" for a node with an assignee (name from the active workspace's members). */
function AssigneeLine({ node }: { node: TodoNode }): React.ReactNode {
  const c = useColors();
  const { t } = useTranslation();
  const ws = useWorkspaceStore((s) => s.activeWorkspaceId);
  const { find } = usePeople(node.assignee ? ws : null);
  if (!node.assignee) return null;
  const who = find(node.assignee);
  return (
    <Text color={c.text3} fontSize={11} numberOfLines={1}>
      {t('todo.log.assignedTo', { name: who?.name ?? node.assignee.id })}
    </Text>
  );
}

/** Chevron — rotates 90° when expanded, clickable to toggle */
function Chevron({
  expanded,
  onPress,
  size = 18,
}: {
  expanded: boolean;
  onPress?: () => void;
  size?: number;
}): React.ReactNode {
  const c = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <XStack
        width={size}
        height={size}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
        style={{
          transform: [{ rotate: expanded ? '90deg' : '0deg' }],
        }}
      >
        <ChevronRight
          size={size}
          color={c.text2}
          weight="bold"
        />
      </XStack>
    </Pressable>
  );
}

// ============================================================================
// 5. COMMON NODE RENDERING
// ============================================================================

function nodeSubtitle(n: TodoNode): string | undefined {
  const parts: string[] = [];
  if (n.description) parts.push(truncate(n.description, 60));
  if (typeof n.childCount === 'number' && n.childCount > 0) {
    const completed = n.completedChildren ?? 0;
    parts.push(`${completed}/${n.childCount} completadas`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

/** Tree node row — checkbox + chevron + text, children indented */
function TreeNodeRow({ node, depth = 0 }: { node: TodoNode; depth?: number }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(!node.collapsed);
  const hasChildren = (node.children?.length ?? 0) > 0 || (node.childCount ?? 0) > 0;
  const done = stateOfNode(node) === 'done';
  const titleColor = done ? c.text3 : c.text;

  return (
    <YStack>
      <XStack gap={6} alignItems="center" paddingVertical={3}>
        <StateMark node={node} />
        {hasChildren && (
          <Chevron expanded={expanded} onPress={() => setExpanded(!expanded)} />
        )}
        <YStack flex={1} gap={1}>
          <Text color={titleColor} fontSize={13} fontWeight="400" numberOfLines={2}>
            {node.text ?? node.nodeId}
          </Text>
          {nodeSubtitle(node) && (
            <Text color={c.text3} fontSize={11} numberOfLines={1}>
              {nodeSubtitle(node)}
            </Text>
          )}
        </YStack>
      </XStack>
      {hasChildren && expanded && node.children && node.children.length > 0 && (
        <YStack marginLeft={26} borderLeftWidth={1} borderLeftColor={c.border} paddingLeft={6}>
          {node.children.map((child) => (
            <TreeNodeRow key={child.nodeId} node={child} depth={depth + 1} />
          ))}
        </YStack>
      )}
    </YStack>
  );
}

/** Node header — checkbox + optional chevron + title + subtitle (for cards) */
function NodeHeader({
  node,
  showChevron = false,
  collapsed = false,
}: {
  node: TodoNode;
  showChevron?: boolean;
  collapsed?: boolean;
}): React.ReactNode {
  const c = useColors();
  const titleColor = stateOfNode(node) === 'done' ? c.text3 : c.text;

  return (
    <XStack gap={6} alignItems="flex-start">
      <StateMark node={node} />
      {showChevron && <Chevron expanded={!collapsed} />}
      <YStack flex={1} gap={2}>
        <Text color={titleColor} fontSize={13} fontWeight="400" numberOfLines={2}>
          {node.text ?? node.nodeId}
        </Text>
        {node.description && (
          <Text color={c.text2} fontSize={12} numberOfLines={2}>
            {truncate(node.description, 120)}
          </Text>
        )}
        <AssigneeLine node={node} />
      </YStack>
    </XStack>
  );
}

/** Instructions block — bordered violet, full markdown, no truncation, scrollable */
function InstructionsBlock({ text }: { text: string }): React.ReactNode {
  return (
    <YStack
      borderWidth={1}
      borderColor={colors.violetGlow}
      borderRadius={6}
      padding={10}
      backgroundColor="rgba(139,92,246,0.06)"
      gap={6}
    >
      <Text color={colors.violet} fontSize={9} fontFamily="$mono" textTransform="uppercase">
        instrucciones
      </Text>
      <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator>
        <MarkdownContent text={text} compact />
      </ScrollView>
    </YStack>
  );
}

/** Log list — "historial" with relative time */
function LogList({ entries }: { entries?: LogEntry[] }): React.ReactNode {
  const c = useColors();
  if (!entries || entries.length === 0) return null;
  const recent = entries.slice(-8).reverse();
  return (
    <YStack gap={3} marginTop={6}>
      <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
        historial ({entries.length})
      </Text>
      {recent.map((entry, i) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list within card
          key={i}
          gap={8}
          alignItems="flex-start"
        >
          <Text color={c.text3} fontSize={10} fontFamily="$mono" numberOfLines={1}>
            {relativeTime(entry.timestamp)}
          </Text>
          <Text color={c.text} fontSize={11} flex={1}>
            {truncate(entry.text, 200)}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

// ============================================================================
// 6. SUB-RENDERERS
// ============================================================================

// --- get-tree ---

function GetTreeRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const tree = (parsed as { tree?: TodoNode[] })?.tree ?? [];
  const nodeCount = tree.length;

  const nodeDescription = nodeCount > 0
    ? contextualDescription('get', `${nodeCount} root ${nodeCount === 1 ? 'node' : 'nodes'}`)
    : getToolDescription(toolName);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {tree.length === 0 ? (
        <Empty message="No hay nodos todavía" />
      ) : (
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator>
          <YStack gap={2}>
            {tree.map((node) => (
              <TreeNodeRow key={node.nodeId} node={node} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

// --- get-node ---

function GetNodeRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('get', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          {node.instructions && <InstructionsBlock text={node.instructions} />}
          <LogList entries={node.log} />
        </YStack>
      )}
    </ToolShell>
  );
}

// --- add-node ---

function AddNodeRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');
  const parentText = (parsed as { parentText?: string | null } | null)?.parentText ?? null;

  // The text is in the input before the output arrives (pending approval, running).
  const childText = node?.text ?? (props.input?.text as string | undefined) ?? '';
  // Completed: "Node added: ParentTitle → ChildTitle" (or just "Node added: ChildTitle").
  // Other phases: "Add "ChildTitle"".
  const description =
    status === 'completed' && childText
      ? parentText
        ? `Node added: ${truncate(parentText, 40)} → ${truncate(childText, 40)}`
        : `Node added: ${truncate(childText, 40)}`
      : contextualDescription('add', childText ? `"${truncate(childText, 40)}"` : null);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={description}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          {node.instructions && <InstructionsBlock text={node.instructions} />}
        </YStack>
      )}
    </ToolShell>
  );
}

// --- update-node ---

function UpdateNodeRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('update', title);

  const changedFields: KeyValueRow[] = [];
  if (input) {
    if (input.text !== undefined) changedFields.push({ key: 'título', value: truncate(String(input.text), 60) });
    if (input.description !== undefined) changedFields.push({ key: 'descripción', value: truncate(String(input.description), 60) });
    if (input.instructions !== undefined) changedFields.push({ key: 'instrucciones', value: '(actualizadas)' });
  }

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          {changedFields.length > 0 && (
            <YStack gap={4}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                cambios
              </Text>
              <KeyValueGrid rows={changedFields} />
            </YStack>
          )}
        </YStack>
      )}
    </ToolShell>
  );
}

// --- toggle-complete ---

function ToggleCompleteRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('toggle complete for', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          <XStack gap={6} alignItems="center">
            {node.completed ? (
              <Badge text="completado" variant="success" />
            ) : (
              <Badge text="pendiente" variant="warning" />
            )}
          </XStack>
        </YStack>
      )}
    </ToolShell>
  );
}

// --- toggle-collapse ---

function ToggleCollapseRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('toggle collapse for', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} showChevron collapsed={node.collapsed} />
          <Text color={c.text2} fontSize={11}>
            {node.collapsed ? 'Colapsado (hijos ocultos)' : 'Expandido (hijos visibles)'}
          </Text>
        </YStack>
      )}
    </ToolShell>
  );
}

// --- move-node ---

function MoveNodeRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('move', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          <Text color={c.text2} fontSize={11}>
            Nodo movido
          </Text>
        </YStack>
      )}
    </ToolShell>
  );
}

// --- delete-node ---

function DeleteNodeRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = parsed as { deleted?: boolean; nodeId?: string; node?: { text?: string; description?: string; completed?: boolean } } | null;
  const deletedNode = data?.node;

  const title = deletedNode ? `"${truncate(nodeTitle(deletedNode), 40)}"` : null;
  const nodeDescription = contextualDescription('delete', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {data?.deleted && (
        <YStack gap={8}>
          <XStack gap={6} alignItems="flex-start">
            <StateMark node={deletedNode ?? {}} />
            <YStack flex={1} gap={2}>
              <Text
                color={c.text3}
                fontSize={13}
                fontWeight="400"
                numberOfLines={2}
                style={{ textDecorationLine: 'line-through' }}
              >
                {deletedNode?.text ?? 'Nodo eliminado'}
              </Text>
              {deletedNode?.description && (
                <Text
                  color={c.text3}
                  fontSize={12}
                  numberOfLines={2}
                  style={{ textDecorationLine: 'line-through' }}
                >
                  {deletedNode.description}
                </Text>
              )}
            </YStack>
          </XStack>
          <XStack gap={6} alignItems="center">
            <Badge text="eliminado" variant="error" />
            <Badge text="irreversible" variant="gray" />
          </XStack>
        </YStack>
      )}
    </ToolShell>
  );
}

// --- search-nodes ---

function SearchNodesRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error, input } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const results = (parsed as { results?: SearchResult[] })?.results ?? [];

  const query = input?.query ? `"${truncate(String(input.query), 40)}"` : null;
  const nodeDescription = contextualDescription('search', query);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {results.length === 0 ? (
        <Empty message="No se encontraron nodos que coincidan" />
      ) : (
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator>
          <YStack gap={2}>
            {results.slice(0, MAX_ITEMS).map((r) => (
              <XStack key={r.nodeId} gap={6} alignItems="center" paddingVertical={3}>
                <StateMark node={r} />
                <YStack flex={1} gap={1}>
                  <Text
                    color={stateOfNode(r) === 'done' ? c.text3 : c.text}
                    fontSize={13}
                    numberOfLines={1}
                  >
                    {r.text ?? r.nodeId}
                  </Text>
                  {r.path && (
                    <Text color={c.text3} fontSize={10} fontFamily="$mono" numberOfLines={1}>
                      {r.path}
                    </Text>
                  )}
                </YStack>
              </XStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolShell>
  );
}

// --- add-log-entry ---

function AddLogEntryRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const node = unwrap<TodoNode>(parsed, 'node', 'nodeId');
  const logEntries = node?.log ?? [];
  const latest = logEntries[logEntries.length - 1];

  const title = node ? `"${truncate(nodeTitle(node), 40)}"` : null;
  const nodeDescription = contextualDescription('add log entry to', title);

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon} description={nodeDescription}>
      {latest && node && (
        <YStack gap={8}>
          <NodeHeader node={node} />
          <YStack
            borderWidth={1}
            borderColor={c.border}
            borderRadius={6}
            padding={10}
            backgroundColor={c.bgInner}
            gap={4}
          >
            <XStack gap={6} alignItems="center">
              <Text color={c.text3} fontSize={10} fontFamily="$mono">
                {relativeTime(latest.timestamp)}
              </Text>
              <Text color={c.text2} fontSize={9} fontFamily="$mono">
                entrada {logEntries.length}
              </Text>
            </XStack>
            <Text color={c.text} fontSize={11}>
              {truncate(latest.text, 200)}
            </Text>
          </YStack>
        </YStack>
      )}
    </ToolShell>
  );
}

// --- health-check ---

function HealthCheckRenderer(props: ToolCallRendererProps) {
  const c = useColors();
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;
  const health = parsed as {
    status?: string;
    version?: string;
    uptime?: number;
    issues?: Array<{ code?: string; message?: string }>;
  } | null;

  return (
    <ToolShell toolName={toolName} status={status} error={error} appIcon={props.appIcon}>
      {health && (
        <YStack gap={8}>
          <XStack gap={6} alignItems="center">
            <Checkbox state={health.status === 'ready' ? 'done' : 'cancelled'} />
            <YStack flex={1} gap={2}>
              <Text color={c.text} fontSize={13} fontWeight="600">
                {health.status ?? 'unknown'}
              </Text>
              <Text color={c.text2} fontSize={11}>
                {`v${health.version ?? '—'} · ${Math.floor((health.uptime ?? 0) / 60)}m uptime`}
              </Text>
            </YStack>
          </XStack>
          {health.issues && health.issues.length > 0 && (
            <YStack gap={3}>
              {health.issues.map((issue, i) => (
                <Text key={i} color={colors.red} fontSize={10}>
                  {issue.code}: {issue.message}
                </Text>
              ))}
            </YStack>
          )}
        </YStack>
      )}
    </ToolShell>
  );
}

// ============================================================================
// 7. FALLBACK
// ============================================================================

function FallbackRenderer(props: ToolCallRendererProps) {
  const { toolName, status, output, error } = props;
  const parsed = output ? parseOutput<unknown>(output) : null;

  return (
    <ToolCallCard
      status={status}
      description={getToolLabel(toolName)}
      iconUri={props.appIcon}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && parsed != null && (
        <JsonPreview value={parsed as Record<string, unknown>} />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// 8. REGISTRY + ENTRY POINT
// ============================================================================

const RENDERER_MAP: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'add-node': AddNodeRenderer,
  'get-node': GetNodeRenderer,
  'get-tree': GetTreeRenderer,
  'update-node': UpdateNodeRenderer,
  'toggle-complete': ToggleCompleteRenderer,
  'toggle-collapse': ToggleCollapseRenderer,
  'move-node': MoveNodeRenderer,
  'delete-node': DeleteNodeRenderer,
  'search-nodes': SearchNodesRenderer,
  'add-log-entry': AddLogEntryRenderer,
  '-health-check': HealthCheckRenderer,
};

function TodoListToolCallRenderer(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const SubRenderer = RENDERER_MAP[shortName];

  const Wrapped = withPermissionSupport(SubRenderer ?? FallbackRenderer);
  return <Wrapped {...props} />;
}

export { TodoListToolCallRenderer };
