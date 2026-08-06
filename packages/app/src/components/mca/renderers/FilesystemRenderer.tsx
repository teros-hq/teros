/**
 * Filesystem MCA — Custom Tool Call Renderer
 *
 * Coverage 100%: one dedicated sub-renderer per tool. Layout, status, icon and
 * default-expand semantics live in `./filesystem/shared.tsx` (`FilesystemToolShell`).
 * Sub-renderers compose global primitives only — no local components.
 *
 * Fallback exists as a dev-only signal of a missing dispatch entry.
 */

import {FileDiff as FileDiffIcon, FileSearch as FileSearchIcon, Fingerprint as FingerprintIcon, FolderPlus as FolderPlusIcon, ListTree as ListTreeIcon, Trash2 as TrashIcon} from '../primitives';
import type React from 'react';
import { Image, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { CodeBlock } from '../CodeBlock';
import {
  type ActionVerb,
  Badge,
  CodeFingerprint,
  colors,
  useColors,
  countBadgeVariant,
  DiffViewer,
  DualEntity,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  IconTile,
  KeyValueGrid,
  MetaStrip,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  ToolCallCard,
} from '../primitives';
import {
  CODE_BLOCK_MAX_HEIGHT,
  type FlatTreeRow,
  FilesystemToolShell,
  KIND_COLORS,
  LIST_RENDER_CAP,
  PaginationFooter,
  asObject,
  baseName,
  emptyState,
  highlightMatch,
  humanSize,
  kindAccent,
  kindIconLeading,
  readBadgeProps,
  shortTime,
  statusType,
  treeConnectors,
} from './filesystem/shared';
import type { ToolCallRendererProps, ToolStatus } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Tool prefix stripping
// ============================================================================

const TOOL_PREFIXES = [
  'filesystem_',
  'mca_teros_filesystem_',
  'mca_teros_admin_filesystem_',
  'fs_',
];

function stripPrefix(toolName: string): string {
  for (const prefix of TOOL_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  const underscoreIdx = toolName.lastIndexOf('_');
  if (underscoreIdx !== -1) return toolName.slice(underscoreIdx + 1);
  return toolName;
}

/**
 * Builds an enriched ErrorBlock from the runtime error string. Filesystem
 * handlers throw with messages of the form `"<short reason>: <detail>"` —
 * we split the first colon to surface a clean title + detail. Hints are
 * derived from common reasons (read-first guard, path traversal, etc.).
 */
function errorBody(error: string | undefined, contextHint?: string) {
  if (!error) return null;
  const trimmed = error.trim();
  // Split title from detail at the first ": " boundary if it looks like one
  const sep = trimmed.indexOf(': ');
  let title = 'Error';
  let message = trimmed;
  if (sep > 0 && sep < 80) {
    title = trimmed.slice(0, sep);
    message = trimmed.slice(sep + 2);
  }
  const hint =
    contextHint ??
    (/Refusing to overwrite/i.test(trimmed)
      ? 'Call `read` on the file first, or use `edit` for surgical changes.'
      : /Path outside allowed roots/i.test(trimmed)
        ? 'Check `list-roots` to see which directories the MCA can access.'
        : /not found|ENOENT/i.test(trimmed)
          ? 'Verify the path. Use `glob` or `list` to find the right one.'
          : /too large/i.test(trimmed)
            ? 'Use `read` with `offset`/`limit` to paginate, or `read-media` for binaries.'
            : /shell|inject/i.test(trimmed)
              ? 'Pattern is treated as regex literal — no shell evaluation happens.'
              : undefined);
  return <ErrorBlock title={title} message={message} hint={hint} />;
}

// ============================================================================
// -health-check
// ============================================================================

function HealthCheckRenderer({ output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const healthStatus = (data?.status as string) || 'unknown';
  const version = (data?.version as string) || '';
  const uptime = typeof data?.uptime === 'number' ? data.uptime : 0;
  const issues = Array.isArray(data?.issues) ? data.issues : [];

  const variant: 'success' | 'warning' | 'error' | 'gray' =
    healthStatus === 'ready' ? 'success' : healthStatus === 'degraded' ? 'warning' : healthStatus === 'not_ready' ? 'error' : 'gray';

  return (
    <FilesystemToolShell
      toolName="-health-check"
      status={status}
      appIcon={appIcon}
      badge={
        status === 'completed' ? <Badge text={healthStatus} variant={variant} /> : null
      }
    >
      {errorBody(error)}
      {data && (
        <Specsheet
          sections={[
            {
              title: 'Diagnostics',
              rows: [
                { key: 'status', value: healthStatus },
                { key: 'version', value: version || '?' },
                { key: 'uptime', value: `${uptime}s` },
                ...(issues.length > 0
                  ? [{ key: 'issues', value: String(issues.length) }]
                  : []),
              ],
            },
          ]}
        />
      )}
      {issues.length > 0 && (
        <YStack gap="$1.5">
          {issues.map((issue: any, idx: number) => (
            <YStack
              key={`iss-${idx}`}
              padding="$2"
              borderRadius="$2"
              backgroundColor={c.bgInner}
              borderWidth={1}
              borderColor={colors.red}
              gap="$1"
            >
              <Text color={colors.red} fontSize={11} fontWeight="bold">
                {String(issue.code || 'issue')}
              </Text>
              <Text color={c.text} fontSize={11}>
                {String(issue.message || '')}
              </Text>
              {issue.action?.description && (
                <Text color={c.text3} fontSize={10} fontFamily="$mono">
                  {String(issue.action.description)}
                </Text>
              )}
            </YStack>
          ))}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// list-roots
// ============================================================================

function ListRootsRenderer({ output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const roots = Array.isArray(data?.roots) ? (data.roots as Array<Record<string, unknown>>) : [];
  const count = typeof data?.count === 'number' ? data.count : roots.length;

  return (
    <FilesystemToolShell
      toolName="list-roots"
      status={status}
      appIcon={appIcon}
      description={`Workspace roots (${count})`}
      badge={
        status === 'completed' ? (
          <Badge text={formatCountBadge(count, 'root')} variant={countBadgeVariant(count)} />
        ) : null
      }
    >
      {errorBody(error)}
      {roots.length === 0 && status === 'completed' && emptyState('No workspace roots configured')}
      {roots.length > 0 && (
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={4}
          paddingVertical={6}
          paddingHorizontal={10}
          gap={3}
        >
          {roots.map((root, idx) => {
            const path = String(root.path ?? '');
            const exists = Boolean(root.exists);
            const type = String(root.type ?? 'missing');
            return (
              <XStack
                key={`${path}-${idx}`}
                gap={10}
                paddingVertical={3}
                alignItems="center"
              >
                <Text
                  color={exists ? colors.green : colors.red}
                  fontSize={11}
                  lineHeight={14}
                  fontFamily="$mono"
                >
                  ●
                </Text>
                <Text
                  flex={1}
                  color={exists ? c.text : c.text3}
                  fontSize={11}
                  fontFamily="$mono"
                  numberOfLines={1}
                  selectable
                >
                  {path || '(unknown)'}
                </Text>
                <Text
                  color={c.text3}
                  fontSize={9}
                  fontFamily="$mono"
                  letterSpacing={1}
                  textTransform="uppercase"
                >
                  {type}
                </Text>
              </XStack>
            );
          })}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// read
// ============================================================================

function ReadRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const filePath = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(filePath);

  const badge =
    status === 'completed' && data ? (() => {
      const props = readBadgeProps(data);
      return <Badge text={props.text} variant={props.variant} />;
    })() : null;

  return (
    <FilesystemToolShell
      toolName="read"
      status={status}
      appIcon={appIcon}
      description={`Read ${name}`}
      badge={badge}
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          <MetaStrip
            items={[
              { key: 'kind', value: String(data.kind ?? '—') },
              { key: 'size', value: data.sizeHuman ?? humanSize(data.size) },
              ...(data.mimeType ? [{ key: 'mime', value: String(data.mimeType) }] : []),
              { key: 'modified', value: shortTime(data.mtime) || '—' },
            ]}
          />
          {typeof data.content === 'string' && data.content.length > 0 && (
            <CodeBlock code={data.content} filename={name} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
          )}
          {(data.totalLines === 0 || data.content === '') && emptyState('Empty file')}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// read-batch
// ============================================================================

function ReadBatchRenderer({ output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const files = Array.isArray(data?.files) ? (data.files as Array<Record<string, any>>) : [];
  const visible = files.slice(0, LIST_RENDER_CAP);
  const truncated = files.length > LIST_RENDER_CAP;

  const badge =
    status === 'completed' && data ? (
      <XStack gap={4}>
        <Badge text={`${data.ok ?? 0} ok`} variant="success" />
        {data.failed ? <Badge text={`${data.failed} failed`} variant="error" /> : null}
      </XStack>
    ) : null;

  return (
    <FilesystemToolShell
      toolName="read-batch"
      status={status}
      appIcon={appIcon}
      description={`Read ${data?.requested ?? files.length} files`}
      badge={badge}
    >
      {errorBody(error)}
      {visible.length > 0 ? (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack>
              {visible.map((f, idx) => (
                <EntityRow
                  key={`${f.file}-${idx}`}
                  leading={kindIconLeading({
                    name: f.name || baseName(f.file),
                    kind: f.kind,
                  })}
                  title={f.name || baseName(f.file)}
                  subtitle={f.file}
                  badges={
                    f.ok ? (
                      <Badge text={`${f.totalLines ?? 0} lines`} variant="info" />
                    ) : (
                      <Badge text="error" variant="error" />
                    )
                  }
                  meta={
                    f.ok ? (
                      <Text color={c.text2} fontSize={9} fontFamily="$mono">
                        {f.sizeHuman ?? humanSize(f.size)}
                      </Text>
                    ) : (
                      <Text color={colors.red} fontSize={9} fontFamily="$mono" numberOfLines={1}>
                        {f.error}
                      </Text>
                    )
                  }
                />
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={files.length}
            returned={visible.length}
            truncated={truncated}
          />
        </YStack>
      ) : (
        data && emptyState('No files requested')
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// read-media
// ============================================================================

function ReadMediaRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(path);
  const mimeType = (data?.mimeType as string) || '';
  const isImage = mimeType.startsWith('image/');
  const base64 = (data?.base64 as string) || '';

  return (
    <FilesystemToolShell
      toolName="read-media"
      status={status}
      appIcon={appIcon}
      description={`Read media ${name || path}`}
      badge={
        status === 'completed' && mimeType ? <Badge text={mimeType} variant="info" /> : null
      }
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          {isImage && base64 ? (
            <YStack
              backgroundColor={c.bgInner}
              borderRadius={6}
              borderWidth={1}
              borderColor={c.border}
              padding={6}
              alignItems="center"
            >
              <Image
                source={{ uri: `data:${mimeType};base64,${base64}` }}
                style={{ width: '100%', maxWidth: 480, height: 320, borderRadius: 4 }}
                resizeMode="contain"
                accessibilityLabel={name}
              />
              <YStack
                marginTop={8}
                paddingHorizontal={6}
                paddingVertical={4}
                width="100%"
              >
                <MetaStrip
                  items={[
                    { key: 'name', value: name || path },
                    { key: 'mime', value: mimeType || '?' },
                    { key: 'size', value: humanSize(data.size as number) || '—' },
                    ...(data.mtime
                      ? [{ key: 'modified', value: shortTime(data.mtime as string) }]
                      : []),
                  ]}
                />
              </YStack>
            </YStack>
          ) : (
            <YStack gap="$2">
              <ResourceCard
                leading={kindIconLeading({ name, kind: 'binary' })}
                title={name || path}
                subtitle={path}
              />
              <MetaStrip
                items={[
                  { key: 'mime', value: mimeType || '?' },
                  { key: 'size', value: humanSize(data.size as number) || '—' },
                  ...(data.mtime
                    ? [{ key: 'modified', value: shortTime(data.mtime as string) }]
                    : []),
                ]}
              />
              <Text color={c.text3} fontSize={10} fontFamily="$mono">
                Preview not supported for {mimeType || 'this format'} — use the base64 payload to process out of band.
              </Text>
            </YStack>
          )}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// write
// ============================================================================

function WriteRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const filePath = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(filePath);
  const verb: ActionVerb | undefined =
    status === 'completed' && data ? (data.created ? 'created' : 'updated') : undefined;
  const previewSource =
    typeof data?.preview === 'string'
      ? data.preview
      : typeof input?.content === 'string'
        ? (input.content as string)
        : '';

  return (
    <FilesystemToolShell
      toolName="write"
      status={status}
      appIcon={appIcon}
      description={`Write ${name}`}
      input={input}
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          <ResourceCard
            leading={kindIconLeading({ name, kind: 'text' })}
            title={name}
            subtitle={data.file ?? filePath}
            verb={verb}
            meta={
              <Badge
                text={`${humanSize(data.bytesWritten)} · ${data.lineCount ?? 0} lines`}
                variant="info"
              />
            }
          />
          {previewSource.length > 0 && (
            <YStack gap="$1">
              <Text color={c.text3} fontSize={10} fontFamily="$mono">
                {data.previewTruncated ? 'Preview (truncated)' : 'Preview'}
              </Text>
              <CodeBlock code={previewSource} filename={name} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
            </YStack>
          )}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// append
// ============================================================================

function AppendRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const filePath = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(filePath);
  const verb: ActionVerb | undefined =
    status === 'completed' && data ? (data.created ? 'created' : 'updated') : undefined;
  const appendedSource =
    typeof data?.appendedPreview === 'string'
      ? data.appendedPreview
      : typeof input?.content === 'string'
        ? (input.content as string)
        : '';

  return (
    <FilesystemToolShell
      toolName="append"
      status={status}
      appIcon={appIcon}
      description={`Append to ${name}`}
      input={input}
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          <ResourceCard
            leading={kindIconLeading({ name, kind: 'text' })}
            title={name}
            subtitle={data.file ?? filePath}
            verb={verb}
            meta={<Badge text={`+${humanSize(data.bytesAppended)}`} variant="success" />}
          >
            <KeyValueGrid
              rows={[
                { key: 'total size', value: data.totalSizeHuman ?? humanSize(data.totalSize) },
              ]}
            />
          </ResourceCard>
          {appendedSource.length > 0 && (
            <YStack gap="$1">
              <Text color={c.text3} fontSize={10} fontFamily="$mono">
                {data.appendedPreviewTruncated ? 'Appended chunk (truncated)' : 'Appended chunk'}
              </Text>
              <CodeBlock code={appendedSource} filename={name} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
            </YStack>
          )}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// edit
// ============================================================================

function EditRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const filePath = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(filePath);
  const replacements = data?.replacements ?? 0;
  const dryRun = Boolean(data?.dryRun);

  const badge =
    status === 'completed' && data ? (
      <XStack gap={4}>
        <Badge text={`${replacements} replaced`} variant={replacements > 0 ? 'success' : 'gray'} />
        {dryRun ? <Badge text="dry-run" variant="warning" /> : null}
      </XStack>
    ) : null;

  return (
    <FilesystemToolShell
      toolName="edit"
      status={status}
      appIcon={appIcon}
      description={`Edit ${name}${dryRun ? ' (preview)' : ''}`}
      badge={badge}
      input={input}
    >
      {errorBody(error)}
      {data && (
        <ResourceCard
          leading={kindIconLeading({ name, kind: 'text' })}
          title={name}
          subtitle={data.file ?? filePath}
          verb={dryRun ? undefined : 'updated'}
        >
          <DiffViewer diff={data.diff} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
        </ResourceCard>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// patch
// ============================================================================

function PatchRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const filePath = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(filePath);
  const applied = Boolean(data?.applied);
  const dryRun = Boolean(data?.dryRun);

  const badge =
    status === 'completed' && data ? (
      <XStack gap={4}>
        {applied ? (
          <Badge text={`${data.hunksApplied} hunks`} variant="success" />
        ) : (
          <Badge text={`${data.hunksFailed} hunks failed`} variant="error" />
        )}
        {dryRun ? <Badge text="dry-run" variant="warning" /> : null}
      </XStack>
    ) : null;

  return (
    <FilesystemToolShell
      toolName="patch"
      status={status}
      appIcon={appIcon}
      description={`Patch ${name}${dryRun ? ' (preview)' : ''}`}
      badge={badge}
      input={input}
    >
      {errorBody(error)}
      {data && (
        <ResourceCard
          leading={<IconTile icon={<FileDiffIcon size={16} color={kindAccent('text')} />} size={28} />}
          title={name}
          subtitle={data.file ?? filePath}
          verb={applied && !dryRun ? 'updated' : undefined}
        >
          {applied ? (
            <DiffViewer diff={data.diff} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
          ) : (
            <YStack gap="$2">
              {data.error && (
                <ErrorBlock
                  title="Patch failed"
                  message={String(data.error)}
                  hint={
                    data.hunksFailed
                      ? `${data.hunksFailed} hunk(s) didn't apply. Re-read the file and rebuild the diff.`
                      : 'Re-read the file and rebuild the diff against current content.'
                  }
                />
              )}
              {typeof data.diff === 'string' && data.diff.length > 0 && (
                <YStack borderWidth={1} borderColor={colors.red} borderRadius="$2">
                  <DiffViewer diff={data.diff} maxHeight={CODE_BLOCK_MAX_HEIGHT} />
                </YStack>
              )}
            </YStack>
          )}
        </ResourceCard>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// list / tree / glob — shared row helper
// ============================================================================

interface DirEntryLike {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  sizeHuman?: string;
  mtime?: string;
  kind?: string;
  depth?: number;
}

function entryRowFor(entry: DirEntryLike, key: string): React.ReactNode {
  const c = useColors();
  const isDir = entry.type === 'directory';
  return (
    <EntityRow
      key={key}
      leading={kindIconLeading({ name: entry.name, kind: entry.kind, type: entry.type })}
      title={entry.name}
      subtitle={entry.path}
      badges={
        <>
          <Badge text={entry.type} variant={isDir ? 'info' : 'gray'} />
          {entry.kind && entry.kind !== 'unknown' ? (
            <Badge text={entry.kind} variant="gray" />
          ) : null}
        </>
      }
      meta={
        <YStack alignItems="flex-end">
          <Text color={c.text2} fontSize={9} fontFamily="$mono">
            {entry.sizeHuman ?? humanSize(entry.size)}
          </Text>
          {entry.mtime ? (
            <Text color={c.text3} fontSize={8} fontFamily="$mono">
              {shortTime(entry.mtime)}
            </Text>
          ) : null}
        </YStack>
      }
    />
  );
}

// ============================================================================
// list
// ============================================================================

function ListRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.path as string) || data?.path || '';
  const entries = (data?.entries ?? []) as DirEntryLike[];
  const visible = entries.slice(0, LIST_RENDER_CAP);
  const truncated = entries.length > LIST_RENDER_CAP || Boolean(data?.truncated);

  return (
    <FilesystemToolShell
      toolName="list"
      status={status}
      appIcon={appIcon}
      description={`List ${baseName(path) || '/'}`}
      badge={
        status === 'completed' && data ? (
          <Badge text={`${data.totalEntries ?? entries.length} entries`} variant="info" />
        ) : null
      }
    >
      {errorBody(error)}
      {visible.length > 0 ? (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack>
              {visible.map((e, idx) => entryRowFor(e, `${e.path}-${idx}`))}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={data?.totalEntries ?? entries.length}
            returned={visible.length}
            truncated={truncated}
            cursor={data?.nextCursor as string | undefined}
          />
        </YStack>
      ) : (
        data && emptyState('Directory is empty')
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// tree
// ============================================================================

interface TreeNodeLike {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
  children?: TreeNodeLike[];
}

type TreeRow = FlatTreeRow<DirEntryLike>;

function flattenTree(
  node: TreeNodeLike | undefined,
  depth: number,
  isLast: boolean,
  ancestors: boolean[],
  out: TreeRow[],
) {
  if (!node) return;
  if (depth > 0) {
    out.push({
      depth,
      isLast,
      ancestorIsLast: [...ancestors],
      payload: {
        name: node.name,
        path: node.path,
        type: node.type,
        size: node.size,
        mtime: node.mtime,
      },
    });
  }
  if (node.children) {
    const nextAncestors = depth > 0 ? [...ancestors, isLast] : ancestors;
    const total = node.children.length;
    node.children.forEach((child, idx) => {
      flattenTree(child, depth + 1, idx === total - 1, nextAncestors, out);
    });
  }
}

function TreeRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.path as string) || data?.root || '';
  const flat: TreeRow[] = [];
  if (data?.tree) flattenTree(data.tree as TreeNodeLike, 0, true, [], flat);
  const visible = flat.slice(0, LIST_RENDER_CAP);
  const truncated = flat.length > LIST_RENDER_CAP || Boolean(data?.truncated);

  return (
    <FilesystemToolShell
      toolName="tree"
      status={status}
      appIcon={appIcon}
      description={`Tree ${baseName(path) || '/'}`}
      badge={
        status === 'completed' && data ? (
          <XStack gap={4}>
            <Badge text={`${data.totalNodes ?? flat.length} nodes`} variant="info" />
            {data.truncated ? <Badge text="truncated" variant="warning" /> : null}
          </XStack>
        ) : null
      }
    >
      {errorBody(error)}
      {visible.length > 0 ? (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack
              backgroundColor={c.bgInner}
              borderRadius={4}
              paddingVertical={6}
              paddingHorizontal={8}
            >
              {visible.map((row, idx) => {
                const prefix = treeConnectors(row);
                const isDir = row.payload.type === 'directory';
                return (
                  <XStack
                    key={`${row.payload.path}-${idx}`}
                    alignItems="center"
                    gap={6}
                    paddingVertical={1}
                  >
                    <Text
                      color={c.text3}
                      fontFamily="$mono"
                      fontSize={11}
                      lineHeight={16}
                    >
                      {prefix}
                    </Text>
                    <Text
                      color={isDir ? c.text : c.text}
                      fontFamily="$mono"
                      fontSize={11}
                      lineHeight={16}
                      fontWeight={isDir ? 'bold' : '400'}
                      selectable
                    >
                      {row.payload.name}
                      {isDir ? '/' : ''}
                    </Text>
                    {row.payload.size !== undefined && !isDir ? (
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {humanSize(row.payload.size)}
                      </Text>
                    ) : null}
                  </XStack>
                );
              })}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={data?.totalNodes ?? flat.length}
            returned={visible.length}
            truncated={truncated}
          />
        </YStack>
      ) : (
        data && emptyState('Empty tree')
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// glob
// ============================================================================

function GlobRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const pattern = (input?.pattern as string) || data?.pattern || '';
  const entries = (data?.entries ?? []) as Array<{
    path: string;
    size: number;
    mtime: string;
  }>;
  const visible = entries.slice(0, LIST_RENDER_CAP);
  const truncated = entries.length > LIST_RENDER_CAP || Boolean(data?.truncated);

  // Heuristic: extract the last "wordy" segment of the glob to highlight in paths.
  const highlightToken = extractGlobHighlightToken(pattern);

  return (
    <FilesystemToolShell
      toolName="glob"
      status={status}
      appIcon={appIcon}
      description={`Glob ${pattern}`}
      badge={
        status === 'completed' && data ? (
          <XStack gap={4}>
            <Badge text={`${data.totalFound ?? entries.length} matches`} variant="info" />
            {data.truncated ? <Badge text="truncated" variant="warning" /> : null}
          </XStack>
        ) : null
      }
    >
      {errorBody(error)}
      {visible.length > 0 ? (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack>
              {visible.map((e, idx) => {
                const name = baseName(e.path);
                return (
                  <EntityRow
                    key={`${e.path}-${idx}`}
                    leading={kindIconLeading({ name })}
                    title={name}
                    subtitle={
                      highlightToken
                        ? highlightMatch(e.path, highlightToken, { caseInsensitive: true, accent: colors.indigo })
                        : e.path
                    }
                    meta={
                      <YStack alignItems="flex-end">
                        <Text color={c.text2} fontSize={9} fontFamily="$mono">
                          {humanSize(e.size)}
                        </Text>
                        <Text color={c.text3} fontSize={8} fontFamily="$mono">
                          {shortTime(e.mtime)}
                        </Text>
                      </YStack>
                    }
                  />
                );
              })}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={data?.totalFound ?? entries.length}
            returned={visible.length}
            truncated={truncated}
          />
        </YStack>
      ) : (
        data && emptyState('No matches')
      )}
    </FilesystemToolShell>
  );
}

function extractGlobHighlightToken(pattern: string): string {
  if (!pattern) return '';
  // Trim trailing wildcards, take the last alphanumeric chunk
  const cleaned = pattern.replace(/[*?{}\[\]]/g, ' ');
  const tokens = cleaned.split(/[\s/\\]+/).filter(Boolean);
  if (tokens.length === 0) return '';
  // Prefer the last token (most specific) and keep it short
  const last = tokens[tokens.length - 1];
  return last && last.length >= 2 ? last : '';
}

// ============================================================================
// grep
// ============================================================================

function GrepRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const pattern = (input?.pattern as string) || data?.pattern || '';
  const mode = (data?.mode as string) ?? 'content';
  const caseInsensitive = Boolean(input?.caseInsensitive);

  const badge =
    status === 'completed' && data ? (
      <XStack gap={4}>
        <Badge text={`${data.totalMatches ?? 0} matches`} variant="info" />
        <Badge text={`${data.totalFiles ?? 0} files`} variant="gray" />
        {data.truncated ? <Badge text="truncated" variant="warning" /> : null}
      </XStack>
    ) : null;

  const matches = Array.isArray(data?.matches) ? (data.matches as Array<any>) : [];
  const visibleMatches = matches.slice(0, LIST_RENDER_CAP);
  const matchesTruncated = matches.length > LIST_RENDER_CAP;

  return (
    <FilesystemToolShell
      toolName="grep"
      status={status}
      appIcon={appIcon}
      description={`Grep "${pattern}"`}
      badge={badge}
    >
      {errorBody(error)}
      {mode === 'count' && data && (
        <KeyValueGrid
          rows={[
            { key: 'matches', value: String(data.totalMatches ?? 0) },
            { key: 'files', value: String(data.totalFiles ?? 0) },
          ]}
        />
      )}
      {mode === 'files' && Array.isArray(data?.files) && data.files.length > 0 && (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack>
              {data.files.map((f: any, idx: number) => (
                <EntityRow
                  key={`${f.file}-${idx}`}
                  leading={kindIconLeading({ name: baseName(f.file) })}
                  title={baseName(f.file)}
                  subtitle={f.file}
                  badges={<Badge text={`${f.matchCount} hits`} variant="success" />}
                />
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={data?.totalFiles ?? data.files.length}
            returned={data.files.length}
            truncated={Boolean(data?.truncated)}
          />
        </YStack>
      )}
      {mode === 'content' && visibleMatches.length > 0 && (
        <YStack gap="$1.5">
          <ScrollView style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}>
            <YStack gap={8}>
              {visibleMatches.map((m: any, idx: number) => (
                <YStack
                  key={`${m.file}-${m.lineNumber}-${idx}`}
                  backgroundColor={c.bgInner}
                  borderWidth={1}
                  borderColor={c.border}
                  borderRadius={4}
                  overflow="hidden"
                >
                  <XStack
                    gap={8}
                    alignItems="center"
                    paddingHorizontal={10}
                    paddingVertical={6}
                    backgroundColor={c.bgInner}
                    borderBottomWidth={1}
                    borderBottomColor={c.border}
                  >
                    <FileSearchIcon size={12} color={colors.indigo} />
                    <Text color={c.text} fontSize={11} fontFamily="$body" fontWeight="bold">
                      {baseName(m.file)}
                    </Text>
                    <Text color={c.text3} fontSize={9} fontFamily="$mono" numberOfLines={1} flex={1}>
                      {m.file}
                    </Text>
                    <Badge text={`:${m.lineNumber}`} variant="info" />
                  </XStack>
                  <YStack paddingHorizontal={6} paddingVertical={4} gap={1}>
                    {Array.isArray(m.contextBefore) &&
                      m.contextBefore.map((c: any, i: number) => (
                        <XStack key={`b-${i}`} gap={8}>
                          <Text width={36} textAlign="right" color={c.text3} fontSize={9} fontFamily="$mono">
                            {c.lineNumber}
                          </Text>
                          <Text flex={1} color={c.text2} fontSize={10} fontFamily="$mono" lineHeight={14}>
                            {highlightMatch(String(c.text), pattern, {
                              caseInsensitive,
                              accent: c.text3,
                            })}
                          </Text>
                        </XStack>
                      ))}
                    <XStack gap={8} backgroundColor="rgba(34,197,94,0.08)" borderRadius={2}>
                      <Text width={36} textAlign="right" color={colors.green} fontSize={9} fontFamily="$mono" fontWeight="bold">
                        {m.lineNumber}
                      </Text>
                      <Text flex={1} color={c.text} fontSize={10} fontFamily="$mono" lineHeight={14}>
                        {highlightMatch(String(m.lineText ?? ''), pattern, {
                          caseInsensitive,
                          accent: colors.green,
                        })}
                      </Text>
                    </XStack>
                    {Array.isArray(m.contextAfter) &&
                      m.contextAfter.map((c: any, i: number) => (
                        <XStack key={`a-${i}`} gap={8}>
                          <Text width={36} textAlign="right" color={c.text3} fontSize={9} fontFamily="$mono">
                            {c.lineNumber}
                          </Text>
                          <Text flex={1} color={c.text2} fontSize={10} fontFamily="$mono" lineHeight={14}>
                            {highlightMatch(String(c.text), pattern, {
                              caseInsensitive,
                              accent: c.text3,
                            })}
                          </Text>
                        </XStack>
                      ))}
                  </YStack>
                </YStack>
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter
            total={data?.totalMatches ?? matches.length}
            returned={visibleMatches.length}
            truncated={matchesTruncated || Boolean(data?.truncated)}
          />
        </YStack>
      )}
      {mode === 'content' && matches.length === 0 && data && emptyState('No matches')}
      {mode === 'files' && (!Array.isArray(data?.files) || data.files.length === 0) && data && emptyState('No matching files')}
    </FilesystemToolShell>
  );
}

// ============================================================================
// stat
// ============================================================================

function StatRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.path as string) || data?.path || '';
  const name = data?.name || baseName(path);
  const exists = Boolean(data?.exists);

  const sections: SpecsheetSection[] = exists && data
    ? [
        {
          title: 'Identity',
          rows: [
            { key: 'name', value: String(name || '—') },
            { key: 'type', value: String(data.type ?? '—') },
            ...(data.kind ? [{ key: 'kind', value: String(data.kind) }] : []),
            ...(data.mimeType ? [{ key: 'mime', value: String(data.mimeType) }] : []),
          ],
        },
        {
          title: 'Physical',
          rows: [
            { key: 'size', value: String(data.sizeHuman ?? humanSize(data.size)) },
            { key: 'permissions', value: `${data.permissions ?? '—'}  (octal)` },
          ],
        },
        {
          title: 'Timeline',
          rows: [
            { key: 'modified', value: shortTime(data.mtime) || '—' },
            ...(data.ctime ? [{ key: 'created', value: shortTime(data.ctime as string) }] : []),
            ...(data.birthtime
              ? [{ key: 'birth', value: shortTime(data.birthtime as string) }]
              : []),
          ],
        },
      ]
    : [];

  return (
    <FilesystemToolShell
      toolName="stat"
      status={status}
      appIcon={appIcon}
      description={`Stat ${name || path}`}
      badge={
        status === 'completed' && data ? (
          <Badge
            text={exists ? (data.type as string) : 'missing'}
            variant={exists ? 'info' : 'error'}
          />
        ) : null
      }
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          <ResourceCard
            leading={kindIconLeading({
              name: name || path,
              kind: data.kind,
              type: data.type,
            })}
            title={name || path}
            subtitle={path}
          />
          {exists ? (
            <Specsheet sections={sections} />
          ) : (
            emptyState('Path does not exist', path)
          )}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// hash
// ============================================================================

function HashRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.filePath as string) || data?.file || '';
  const name = data?.name || baseName(path);
  const algorithm = String(data?.algorithm ?? input?.algorithm ?? 'sha256').toUpperCase();
  const hashValue = String(data?.hash ?? '');

  return (
    <FilesystemToolShell
      toolName="hash"
      status={status}
      appIcon={appIcon}
      description={`Hash ${name || path}`}
      badge={
        status === 'completed' ? <Badge text={algorithm} variant="info" /> : null
      }
    >
      {errorBody(error)}
      {data && (
        <YStack gap="$2">
          <ResourceCard
            leading={
              <IconTile
                icon={<FingerprintIcon size={16} color={c.text3} />}
                size={28}
                accent={c.text3}
              />
            }
            title={name || path}
            subtitle={path}
          />
          {hashValue && (
            <CodeFingerprint
              hash={hashValue}
              algorithm={algorithm}
              size={typeof data.size === 'number' ? humanSize(data.size as number) : undefined}
            />
          )}
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// delete
// ============================================================================

function DeleteRenderer({
  input,
  output,
  status,
  duration,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.path as string) || data?.path || '';
  const name = data?.name || baseName(path);
  const existed = Boolean(data?.existed);

  return (
    <FilesystemToolShell
      toolName="delete"
      status={status}
      appIcon={appIcon}
      description={`Delete ${name}`}
      input={input}
      badge={
        status === 'completed' ? (
          <Badge
            text={existed ? 'deleted' : 'did not exist'}
            variant={existed ? 'error' : 'gray'}
          />
        ) : null
      }
    >
      {errorBody(error)}
      {data && (
        <YStack opacity={existed ? 1 : 0.55}>
          <ResourceCard
            leading={
              <IconTile
                icon={
                  <TrashIcon
                    size={16}
                    color={existed ? colors.red : c.text3}
                  />
                }
                size={28}
              />
            }
            title={
              <Text
                color={existed ? c.text : c.text3}
                fontSize={13}
                fontFamily="$body"
                fontWeight="bold"
                textDecorationLine={existed ? 'line-through' : 'none'}
              >
                {name}
              </Text>
            }
            subtitle={
              <Text
                color={c.text2}
                fontSize={10}
                fontFamily="$mono"
                textDecorationLine={existed ? 'line-through' : 'none'}
              >
                {path}
              </Text>
            }
            verb={existed ? 'deleted' : undefined}
          >
            {!existed && (
              <Text color={c.text3} fontSize={10} fontFamily="$mono">
                Path was already absent. No-op.
              </Text>
            )}
          </ResourceCard>
        </YStack>
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// copy
// ============================================================================

function CopyRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const source = (input?.source as string) || data?.source || '';
  const destination = (input?.destination as string) || data?.destination || '';
  const sourceName = data?.sourceName || baseName(source);
  const destName = data?.destinationName || baseName(destination);
  const isDir = data?.type === 'directory';

  const sizeLabel = humanSize(data?.size as number);
  const meta = sizeLabel
    ? data?.overwritten
      ? `${sizeLabel} (overwritten)`
      : sizeLabel
    : data?.overwritten
      ? 'overwritten'
      : undefined;

  return (
    <FilesystemToolShell
      toolName="copy"
      status={status}
      appIcon={appIcon}
      description={`Copy ${sourceName} → ${destName}`}
      input={input}
      badge={
        status === 'completed' && data?.overwritten ? (
          <Badge text="overwritten" variant="warning" />
        ) : null
      }
    >
      {errorBody(error)}
      {data && (
        <DualEntity
          left={{
            visual: kindIconLeading({ name: sourceName, type: isDir ? 'directory' : 'file' }),
            title: sourceName,
            subtitle: source,
          }}
          right={{
            visual: kindIconLeading({ name: destName, type: isDir ? 'directory' : 'file' }),
            title: destName,
            subtitle: destination,
          }}
          action="transfer"
          meta={meta}
        />
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// move
// ============================================================================

function MoveRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const source = (input?.source as string) || data?.source || '';
  const destination = (input?.destination as string) || data?.destination || '';
  const sourceName = data?.sourceName || baseName(source);
  const destName = data?.destinationName || baseName(destination);
  const isDir = data?.type === 'directory';
  const overwritten = Boolean(data?.overwritten);

  return (
    <FilesystemToolShell
      toolName="move"
      status={status}
      appIcon={appIcon}
      description={`Move ${sourceName} → ${destName}`}
      input={input}
      badge={
        status === 'completed' ? (
          <Badge
            text={overwritten ? 'overwritten' : 'moved'}
            variant={overwritten ? 'warning' : 'success'}
          />
        ) : null
      }
    >
      {errorBody(error)}
      {data && (
        <DualEntity
          left={{
            visual: kindIconLeading({ name: sourceName, type: isDir ? 'directory' : 'file' }),
            title: sourceName,
            subtitle: source,
          }}
          right={{
            visual: kindIconLeading({ name: destName, type: isDir ? 'directory' : 'file' }),
            title: destName,
            subtitle: destination,
          }}
          action="transfer"
        />
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// mkdir
// ============================================================================

function MkdirRenderer({ input, output, status, duration, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const data = asObject(output);
  const path = (input?.path as string) || data?.path || '';
  const name = data?.name || baseName(path);
  const created = Boolean(data?.created);

  return (
    <FilesystemToolShell
      toolName="mkdir"
      status={status}
      appIcon={appIcon}
      description={`Mkdir ${name}`}
      input={input}
      badge={
        status === 'completed' ? (
          <Badge text={created ? 'created' : 'already existed'} variant={created ? 'success' : 'gray'} />
        ) : null
      }
    >
      {errorBody(error)}
      {data && (
        <ResourceCard
          leading={
            <IconTile
              icon={
                <FolderPlusIcon
                  size={16}
                  color={created ? colors.green : c.text3}
                />
              }
              size={28}
              accent={created ? colors.green : undefined}
            />
          }
          title={name}
          subtitle={path}
          verb={created ? 'created' : undefined}
        />
      )}
    </FilesystemToolShell>
  );
}

// ============================================================================
// Dispatch
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  read: ReadRenderer,
  'read-batch': ReadBatchRenderer,
  'read-media': ReadMediaRenderer,
  write: WriteRenderer,
  append: AppendRenderer,
  edit: EditRenderer,
  patch: PatchRenderer,
  list: ListRenderer,
  'list-roots': ListRootsRenderer,
  tree: TreeRenderer,
  stat: StatRenderer,
  hash: HashRenderer,
  glob: GlobRenderer,
  grep: GrepRenderer,
  delete: DeleteRenderer,
  copy: CopyRenderer,
  move: MoveRenderer,
  mkdir: MkdirRenderer,
};

function FallbackRenderer({ toolName, status, duration, output, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const shortName = stripPrefix(toolName);
  console.warn(
    `[FilesystemRenderer] No dedicated renderer for tool "${shortName}" — fallback indicates a bug`,
  );
  return (
    <ToolCallCard
      status={statusType(status)}
      description={shortName}
      iconUri={appIcon}
      badge={<Badge text="no renderer" variant="warning" />}
    >
      {errorBody(error)}
      {output && (
        <Text color={c.text3} fontSize={10} fontFamily="$mono" numberOfLines={10}>
          {output}
        </Text>
      )}
    </ToolCallCard>
  );
}

function FilesystemRendererBase(props: ToolCallRendererProps) {
  const c = useColors();
  const shortName = stripPrefix(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const FilesystemToolCallRenderer = withPermissionSupport(FilesystemRendererBase);
export default FilesystemToolCallRenderer;
