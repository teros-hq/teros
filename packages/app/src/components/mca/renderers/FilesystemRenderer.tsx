/**
 * Filesystem MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for filesystem operations.
 * Renders file/folder operations with minimal footprint when collapsed,
 * expandable to show full content with line numbers.
 *
 * Tools:
 * - read: File content with line numbers
 * - write: Created/updated file info
 * - edit: Diff view with old/new strings
 * - list: Directory listing with icons
 * - search-files: Pattern match results
 * - search-content: Grep-style results
 * - delete/copy/move/mkdir: Simple confirmations
 */

import {
  ChevronRight,
  Copy,
  Edit3,
  File,
  FileSearch,
  FileText,
  Folder,
  FolderPlus,
  Move,
  Save,
  Search,
  Trash2,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { CodeBlock } from '../CodeBlock';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Icon
  icon: '#3b82f6',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Diff
  diffAdd: '#86efac',
  diffRemove: '#fca5a5',
  diffAddBg: 'rgba(34,197,94,0.1)',
  diffRemoveBg: 'rgba(239,68,68,0.1)',

  // Line numbers
  lineNum: '#3f3f46',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgDark: 'rgba(0,0,0,0.3)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',

  // Folder/File
  folder: '#fcd34d',
  file: '#9ca3af',
};

// ============================================================================
// Tool Config
// ============================================================================

const toolIcons: Record<string, typeof FileText> = {
  read: FileText,
  write: Save,
  edit: Edit3,
  list: Folder,
  'search-files': Search,
  'search-content': FileSearch,
  delete: Trash2,
  copy: Copy,
  move: Move,
  mkdir: FolderPlus,
};

// ============================================================================
// Utilities
// ============================================================================

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function formatPath(filePath: string): string {
  if (!filePath) return '';
  // Replace home directory
  const path = filePath.replace(/^\/home\/[^/]+/, '~');
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface ParsedOutput {
  success?: boolean;
  bytesWritten?: number;
  newFile?: boolean;
  replacements?: number;
  items?: Array<{ name: string; type: string; size?: number }>;
  matches?: number;
  files?: string[];
  type?: string;
  error?: string;
}

function parseOutput(output: string): ParsedOutput | null {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

// ============================================================================
// Components
// ============================================================================

interface StatusDotProps {
  status: 'running' | 'completed' | 'failed';
}

function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' ? colors.running : status === 'completed' ? colors.success : colors.failed;

  const glow =
    status === 'running'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'info' | 'warning' | 'gray';
}

function Badge({ text, variant }: BadgeProps) {
  const styles = {
    success: colors.badgeSuccess,
    error: colors.badgeError,
    info: colors.badgeInfo,
    warning: colors.badgeWarning,
    gray: colors.badgeGray,
  };
  const { text: textColor, bg } = styles[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  icon: React.ReactNode;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  icon,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : colors.border}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.border}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />
      {icon}

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          running
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

// ============================================================================
// Content Blocks
// ============================================================================

interface FileContentBlockProps {
  content: string;
  filename?: string;
  maxHeight?: number;
}

function FileContentBlock({ content, filename, maxHeight = 360 }: FileContentBlockProps) {
  return (
    <YStack backgroundColor={colors.bgInner} borderRadius={5} overflow="hidden">
      <CodeBlock code={content} filename={filename} maxHeight={maxHeight} />
    </YStack>
  );
}

interface DiffBlockProps {
  oldString: string;
  newString: string;
  filename?: string;
}

/**
 * Simple inline diff - finds common prefix/suffix and highlights the changed part
 */
function computeInlineDiff(
  oldStr: string,
  newStr: string,
): {
  oldParts: Array<{ text: string; changed: boolean }>;
  newParts: Array<{ text: string; changed: boolean }>;
} {
  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (but don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const prefix = oldStr.slice(0, prefixLen);
  const oldMiddle = oldStr.slice(prefixLen, oldStr.length - suffixLen);
  const newMiddle = newStr.slice(prefixLen, newStr.length - suffixLen);
  const suffix = oldStr.slice(oldStr.length - suffixLen);

  const oldParts: Array<{ text: string; changed: boolean }> = [];
  const newParts: Array<{ text: string; changed: boolean }> = [];

  if (prefix) {
    oldParts.push({ text: prefix, changed: false });
    newParts.push({ text: prefix, changed: false });
  }
  if (oldMiddle) {
    oldParts.push({ text: oldMiddle, changed: true });
  }
  if (newMiddle) {
    newParts.push({ text: newMiddle, changed: true });
  }
  if (suffix) {
    oldParts.push({ text: suffix, changed: false });
    newParts.push({ text: suffix, changed: false });
  }

  return { oldParts, newParts };
}

function DiffBlock({ oldString, newString }: DiffBlockProps) {
  const { oldParts, newParts } = computeInlineDiff(oldString, newString);

  return (
    <YStack gap={4}>
      {/* Old (removed) */}
      <ScrollView
        horizontal
        style={{ backgroundColor: colors.diffRemoveBg, borderRadius: 5 }}
        showsHorizontalScrollIndicator={true}
      >
        <XStack paddingVertical={6} paddingHorizontal={8} alignItems="flex-start">
          <Text color={colors.diffRemove} fontSize={10} fontFamily="$mono" marginRight={6}>
            −
          </Text>
          <Text fontSize={10} fontFamily="$mono" style={{ flexShrink: 1 }}>
            {oldParts.map((part, idx) => (
              <Text
                key={idx}
                color={part.changed ? colors.diffRemove : colors.secondary}
                backgroundColor={part.changed ? 'rgba(239,68,68,0.3)' : 'transparent'}
                fontSize={10}
                fontFamily="$mono"
              >
                {part.text}
              </Text>
            ))}
          </Text>
        </XStack>
      </ScrollView>

      {/* New (added) */}
      <ScrollView
        horizontal
        style={{ backgroundColor: colors.diffAddBg, borderRadius: 5 }}
        showsHorizontalScrollIndicator={true}
      >
        <XStack paddingVertical={6} paddingHorizontal={8} alignItems="flex-start">
          <Text color={colors.diffAdd} fontSize={10} fontFamily="$mono" marginRight={6}>
            +
          </Text>
          <Text fontSize={10} fontFamily="$mono" style={{ flexShrink: 1 }}>
            {newParts.map((part, idx) => (
              <Text
                key={idx}
                color={part.changed ? colors.diffAdd : colors.secondary}
                backgroundColor={part.changed ? 'rgba(34,197,94,0.3)' : 'transparent'}
                fontSize={10}
                fontFamily="$mono"
              >
                {part.text}
              </Text>
            ))}
          </Text>
        </XStack>
      </ScrollView>
    </YStack>
  );
}

interface DirectoryListProps {
  items: Array<{ name: string; type: string; size?: number }>;
}

function DirectoryList({ items }: DirectoryListProps) {
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {items.map((item, idx) => (
          <XStack key={idx} alignItems="center" gap={8} paddingVertical={3} paddingHorizontal={8}>
            {item.type === 'directory' ? (
              <Folder size={12} color={colors.folder} />
            ) : (
              <File size={12} color={colors.file} />
            )}
            <Text
              flex={1}
              color={item.type === 'directory' ? colors.bright : colors.secondary}
              fontSize={10}
              fontFamily="$mono"
              numberOfLines={1}
            >
              {item.name}
            </Text>
            {item.size !== undefined && item.type !== 'directory' && (
              <Text color={colors.muted} fontSize={9} fontFamily="$mono">
                {formatBytes(item.size)}
              </Text>
            )}
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

interface SearchResultsProps {
  files: string[];
  pattern?: string;
}

function SearchResults({ files, pattern }: SearchResultsProps) {
  return (
    <YStack gap={4}>
      {pattern && (
        <XStack
          backgroundColor={colors.bgDark}
          paddingVertical={4}
          paddingHorizontal={8}
          borderRadius={4}
          gap={6}
          alignItems="center"
        >
          <Text color={colors.muted} fontSize={9}>
            Pattern:
          </Text>
          <Text color={colors.badgeInfo.text} fontSize={10} fontFamily="$mono">
            {pattern}
          </Text>
        </XStack>
      )}
      <ScrollView
        style={{ maxHeight: 250, backgroundColor: colors.bgInner, borderRadius: 5 }}
        showsVerticalScrollIndicator={true}
      >
        <YStack paddingVertical={4}>
          {files.slice(0, 20).map((file, idx) => (
            <XStack key={idx} alignItems="center" gap={8} paddingVertical={2} paddingHorizontal={8}>
              <FileText size={10} color={colors.file} />
              <Text color={colors.secondary} fontSize={10} fontFamily="$mono" numberOfLines={1}>
                {formatPath(file)}
              </Text>
            </XStack>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  );
}

interface ErrorBlockProps {
  error: string;
}

function ErrorBlock({ error }: ErrorBlockProps) {
  return (
    <YStack
      backgroundColor="rgba(239,68,68,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
    >
      <Text color={colors.badgeError.text} fontSize={10} fontFamily="$mono">
        {error}
      </Text>
    </YStack>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function FilesystemRendererBase(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, duration } = props;

  const [expanded, setExpanded] = useState(false);

  const shortName = getShortToolName(toolName);
  const IconComponent = toolIcons[shortName] || FileText;

  // Build description
  let description = '';
  const filePath = input?.filePath || input?.path || '';
  const pattern = input?.pattern || '';

  switch (shortName) {
    case 'read':
      description = `Read ${formatPath(filePath)}`;
      break;
    case 'write':
      description = `Write ${formatPath(filePath)}`;
      break;
    case 'edit':
      description = `Edit ${formatPath(filePath)}`;
      break;
    case 'list':
      description = `List ${formatPath(filePath) || 'directory'}`;
      break;
    case 'search-files':
      description = `Search files: ${pattern}`;
      break;
    case 'search-content':
      description = `Search content: ${pattern}`;
      break;
    case 'delete':
      description = `Delete ${formatPath(filePath)}`;
      break;
    case 'copy':
      description = `Copy to ${formatPath(input?.destination || '')}`;
      break;
    case 'move':
      description = `Move to ${formatPath(input?.destination || '')}`;
      break;
    case 'mkdir':
      description = `Create ${formatPath(filePath)}`;
      break;
    default:
      description = shortName;
  }

  // Parse output
  const parsed = output ? parseOutput(output) : null;

  // Determine badge
  let badge: React.ReactNode = null;
  let hasExpandedContent = false;

  if (status === 'completed' && parsed) {
    switch (shortName) {
      case 'read': {
        const lineCount = output?.split('\n').length || 0;
        badge = <Badge text={`${lineCount} lines`} variant="gray" />;
        hasExpandedContent = true;
        break;
      }
      case 'write':
        badge = <Badge text={parsed.newFile ? 'created' : 'updated'} variant="success" />;
        hasExpandedContent = !!input?.content;
        break;
      case 'edit':
        badge = <Badge text={`${parsed.replacements || 0} replaced`} variant="info" />;
        hasExpandedContent = !!(input?.oldString && input?.newString);
        break;
      case 'list': {
        const itemCount = parsed.items?.length || 0;
        badge = <Badge text={`${itemCount} items`} variant="gray" />;
        hasExpandedContent = itemCount > 0;
        break;
      }
      case 'search-files':
      case 'search-content':
        badge = <Badge text={`${parsed.matches || 0} found`} variant="info" />;
        hasExpandedContent = (parsed.files?.length || 0) > 0;
        break;
      case 'delete':
        badge = <Badge text="deleted" variant="warning" />;
        break;
      case 'copy':
        badge = <Badge text="copied" variant="success" />;
        break;
      case 'move':
        badge = <Badge text="moved" variant="success" />;
        break;
      case 'mkdir':
        badge = <Badge text="created" variant="success" />;
        break;
    }
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
    hasExpandedContent = !!error;
  }

  const icon = <IconComponent size={12} color={colors.icon} />;

  const headerProps = {
    status,
    icon,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  // Collapsed view
  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  // Expanded view
  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Read: show file content */}
        {shortName === 'read' && output && (
          <FileContentBlock content={output} filename={filePath} />
        )}

        {/* Write: show written content */}
        {shortName === 'write' && input?.content && (
          <FileContentBlock content={input.content} filename={filePath} />
        )}

        {/* Edit: show diff */}
        {shortName === 'edit' && input?.oldString && input?.newString && (
          <DiffBlock oldString={input.oldString} newString={input.newString} />
        )}

        {/* List: show directory contents */}
        {shortName === 'list' && parsed?.items && <DirectoryList items={parsed.items} />}

        {/* Search: show results */}
        {(shortName === 'search-files' || shortName === 'search-content') && parsed?.files && (
          <SearchResults files={parsed.files} pattern={pattern} />
        )}

        {/* Error */}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export const FilesystemToolCallRenderer = withPermissionSupport(FilesystemRendererBase);
export default FilesystemToolCallRenderer;
