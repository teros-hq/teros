/**
 * Google Drive Renderer - Shared Components & Utilities
 */

import {
  Archive,
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  Presentation,
  colors,
  useColors,
  useMcaTheme,
} from '../../primitives';
import type React from 'react';
import { Linking } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';

// ============================================================================
// Constants
// ============================================================================

const DRIVE_ICON = 'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png';

// ============================================================================
// File-type colors — semantic theme-agnostic (file format identity,
// same hue across themes by design). Single source of truth: both
// `getFileTypeInfo()` and `useDriveColors()` reference this object.
// ============================================================================

const FILE_TYPE_COLORS = {
  folder: '#F4B400',
  document: '#4285F4',
  spreadsheet: '#0F9D58',
  presentation: '#F4B400',
  pdf: '#DB4437',
  image: '#DB4437',
  video: '#DB4437',
  audio: '#9334E6',
  archive: '#607D8B',
  code: '#795548',
  other: '#9E9E9E',
} as const;

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

export function useDriveColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Google Drive brand (theme-agnostic — official Google brand kit)
    driveBlue: '#4285F4',

    // File type colors (semantic theme-agnostic — spread from FILE_TYPE_COLORS
    // so there is a single source of truth for file-format identity hues)
    ...FILE_TYPE_COLORS,

    // Status (semantic — from design system palette, theme-agnostic)
    success: colors.green,

    // Badges (theme-adaptive)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive)

    // Press overlay (theme-adaptive — rgba(255,255,255,0.05) is invisible
    // on light surfaces, so we switch to a dark overlay in light mode)
    pressOverlay: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    ...c,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  parents?: string[];
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
}

export interface DriveFolder extends DriveFile {
  mimeType: 'application/vnd.google-apps.folder';
}

// ============================================================================
// Utilities
// ============================================================================

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output: string): T | string | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return output;
  }
}

export function truncate(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function formatFileSize(bytes?: string | number): string {
  if (!bytes) return '';
  const size = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (isNaN(size)) return '';

  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(dateString?: string): string {
  if (!dateString) return '';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

export function isFolder(mimeType: string): boolean {
  return mimeType === 'application/vnd.google-apps.folder';
}

export function isGoogleDoc(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

export function getFileTypeInfo(mimeType: string): {
  icon: React.ComponentType<any>;
  color: string;
  label: string;
} {
  if (mimeType === 'application/vnd.google-apps.folder') {
    return { icon: Folder, color: FILE_TYPE_COLORS.folder, label: 'Folder' };
  }
  if (mimeType === 'application/vnd.google-apps.document') {
    return { icon: FileText, color: FILE_TYPE_COLORS.document, label: 'Doc' };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return { icon: FileSpreadsheet, color: FILE_TYPE_COLORS.spreadsheet, label: 'Sheet' };
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return { icon: Presentation, color: FILE_TYPE_COLORS.presentation, label: 'Slides' };
  }
  if (mimeType === 'application/pdf') {
    return { icon: FileText, color: FILE_TYPE_COLORS.pdf, label: 'PDF' };
  }
  if (mimeType.startsWith('image/')) {
    return { icon: ImageIcon, color: FILE_TYPE_COLORS.image, label: 'Image' };
  }
  if (mimeType.startsWith('video/')) {
    return { icon: Film, color: FILE_TYPE_COLORS.video, label: 'Video' };
  }
  if (mimeType.startsWith('audio/')) {
    return { icon: Music, color: FILE_TYPE_COLORS.audio, label: 'Audio' };
  }
  if (
    mimeType.includes('zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('rar') ||
    mimeType.includes('7z')
  ) {
    return { icon: Archive, color: FILE_TYPE_COLORS.archive, label: 'Archive' };
  }
  if (
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('json') ||
    mimeType.includes('html') ||
    mimeType.includes('css') ||
    mimeType.includes('xml')
  ) {
    return { icon: FileCode, color: FILE_TYPE_COLORS.code, label: 'Code' };
  }
  return { icon: File, color: FILE_TYPE_COLORS.other, label: 'File' };
}

// ============================================================================
// Components
// ============================================================================

export function DriveLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: DRIVE_ICON }} width={size} height={size} borderRadius={2} />;
}

// StatusDot lives in `../../primitives` — ToolCallCard mounts it. The
// Badge re-export uses the canonical theme-adaptive primitive.
export { Badge } from '../../primitives';

interface FileTypeBadgeProps {
  mimeType: string;
}

export function FileTypeBadge({ mimeType }: FileTypeBadgeProps) {
  const { color, label } = getFileTypeInfo(mimeType);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
      alignItems="center"
    >
      <Text color={color} fontSize={8} fontFamily="$mono">
        {label}
      </Text>
    </XStack>
  );
}

// HeaderRow / ExpandedContainer / ExpandedBody / ErrorBlock / SuccessBlock
// live in `../../primitives`. Sub-renderers compose directly via
// `<ToolCallCard>`. Removed local re-implementations to enforce DRY.

interface FileRowProps {
  file: DriveFile;
  onPress?: () => void;
}

export function FileRow({ file, onPress }: FileRowProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const { icon: Icon, color } = getFileTypeInfo(file.mimeType);

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (file.webViewLink) {
      Linking.openURL(file.webViewLink);
    }
  };

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={8}
      backgroundColor={c.bgInner}
      borderRadius={5}
      pressStyle={{ backgroundColor: colors.pressOverlay }}
      onPress={handlePress}
      cursor="pointer"
    >
      <Icon size={14} color={color} />

      <YStack flex={1} gap={2}>
        <Text color={c.text} fontSize={11} numberOfLines={1}>
          {file.name}
        </Text>
        <XStack gap={8}>
          {file.size && (
            <Text color={c.text3} fontSize={9}>
              {formatFileSize(file.size)}
            </Text>
          )}
          {file.modifiedTime && (
            <Text color={c.text3} fontSize={9}>
              {formatDate(file.modifiedTime)}
            </Text>
          )}
        </XStack>
      </YStack>

      <FileTypeBadge mimeType={file.mimeType} />
    </XStack>
  );
}
