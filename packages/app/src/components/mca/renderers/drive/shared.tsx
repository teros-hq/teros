/**
 * Google Drive Renderer - Shared Components & Utilities
 */

import {
  Archive,
  ChevronRight,
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  Presentation,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Linking } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Constants
// ============================================================================

const DRIVE_ICON = 'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png';

// ============================================================================
// Colors
// ============================================================================

export const colors = {
  // Google Drive brand colors
  driveBlue: '#4285F4',
  driveGreen: '#0F9D58',
  driveYellow: '#F4B400',
  driveRed: '#DB4437',

  // File type colors
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

  // Status
  success: '#22c55e',
  running: '#4285F4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(66, 133, 244, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#93c5fd', bg: 'rgba(66,133,244,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgDark: 'rgba(0,0,0,0.3)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

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
  // Folders
  if (mimeType === 'application/vnd.google-apps.folder') {
    return { icon: Folder, color: colors.folder, label: 'Folder' };
  }

  // Google Docs
  if (mimeType === 'application/vnd.google-apps.document') {
    return { icon: FileText, color: colors.document, label: 'Doc' };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return { icon: FileSpreadsheet, color: colors.spreadsheet, label: 'Sheet' };
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return { icon: Presentation, color: colors.presentation, label: 'Slides' };
  }

  // PDFs
  if (mimeType === 'application/pdf') {
    return { icon: FileText, color: colors.pdf, label: 'PDF' };
  }

  // Images
  if (mimeType.startsWith('image/')) {
    return { icon: ImageIcon, color: colors.image, label: 'Image' };
  }

  // Videos
  if (mimeType.startsWith('video/')) {
    return { icon: Film, color: colors.video, label: 'Video' };
  }

  // Audio
  if (mimeType.startsWith('audio/')) {
    return { icon: Music, color: colors.audio, label: 'Audio' };
  }

  // Archives
  if (
    mimeType.includes('zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('rar') ||
    mimeType.includes('7z')
  ) {
    return { icon: Archive, color: colors.archive, label: 'Archive' };
  }

  // Code files
  if (
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('json') ||
    mimeType.includes('html') ||
    mimeType.includes('css') ||
    mimeType.includes('xml')
  ) {
    return { icon: FileCode, color: colors.code, label: 'Code' };
  }

  // Default
  return { icon: File, color: colors.other, label: 'File' };
}

// ============================================================================
// Components
// ============================================================================

export function DriveLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: DRIVE_ICON }} width={size} height={size} borderRadius={2} />;
}

export type ToolStatusType = 'running' | 'completed' | 'failed' | 'pending_permission';

interface StatusDotProps {
  status: ToolStatusType;
}

export function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' || status === 'pending_permission'
      ? colors.running
      : status === 'completed'
        ? colors.success
        : colors.failed;

  const glow =
    status === 'running' || status === 'pending_permission'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' || status === 'pending_permission' ? pulseAnim : 1,
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

export function Badge({ text, variant }: BadgeProps) {
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

export interface HeaderRowProps {
  status: ToolStatusType;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

export function HeaderRow({
  status,
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
      <DriveLogo size={14} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' || status === 'pending_permission' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          {status === 'pending_permission' ? 'awaiting' : 'running'}
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

export function ExpandedContainer({ children }: { children: React.ReactNode }) {
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

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

export function ErrorBlock({ error }: { error: string }) {
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

export function SuccessBlock({ message }: { message: string }) {
  return (
    <XStack
      backgroundColor="rgba(34,197,94,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Text color={colors.badgeSuccess.text} fontSize={10}>
        {message}
      </Text>
    </XStack>
  );
}

interface FileRowProps {
  file: DriveFile;
  onPress?: () => void;
}

export function FileRow({ file, onPress }: FileRowProps) {
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
      backgroundColor={colors.bgInner}
      borderRadius={5}
      pressStyle={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
      onPress={handlePress}
      cursor="pointer"
    >
      <Icon size={14} color={color} />

      <YStack flex={1} gap={2}>
        <Text color={colors.primary} fontSize={11} numberOfLines={1}>
          {file.name}
        </Text>
        <XStack gap={8}>
          {file.size && (
            <Text color={colors.muted} fontSize={9}>
              {formatFileSize(file.size)}
            </Text>
          )}
          {file.modifiedTime && (
            <Text color={colors.muted} fontSize={9}>
              {formatDate(file.modifiedTime)}
            </Text>
          )}
        </XStack>
      </YStack>

      <FileTypeBadge mimeType={file.mimeType} />
    </XStack>
  );
}
