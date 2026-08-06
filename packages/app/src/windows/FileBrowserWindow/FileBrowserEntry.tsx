/**
 * FileBrowserEntry — A single row in the file browser listing
 *
 * Displays:
 *  - Icon (folder or file)
 *  - Name
 *  - Size (files only; directories show '—')
 *  - Last modified date
 *
 * Clicking a directory navigates into it.
 * Clicking a .md file calls the fileOpener hook.
 * Clicking other files shows a toast.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for the folder icon accent (amber).
 * - Uses Tamagui font tokens (`$body`, `$mono`).
 */

import { File, Folder } from '@tamagui/lucide-icons'
import React from 'react'
import { Text, XStack } from 'tamagui'
import type { FileEntry } from '../../services/FileBrowserApi'
import { colors as semanticColors } from '../../components/mca/primitives/colors'
import { useColors } from '../../components/mca/primitives/useColors'

// ============================================================================
// Types
// ============================================================================

interface Props {
  entry: FileEntry
  onNavigate: (path: string) => void
  onOpenFile: (entry: FileEntry) => void
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a byte count as a human-readable string.
 * e.g. 1234567 → '1.2 MB'
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Format an ISO 8601 date string as a short human-readable date.
 * e.g. '2026-03-17T09:12:34.292Z' → 'Mar 17, 2026'
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

// ============================================================================
// Component
// ============================================================================

export function FileBrowserEntry({ entry, onNavigate, onOpenFile }: Props) {
  const c = useColors()
  const isDir = entry.type === 'directory'

  const handlePress = () => {
    if (isDir) {
      onNavigate(entry.path)
    } else {
      onOpenFile(entry)
    }
  }

  const sizeLabel = isDir ? '—' : entry.size !== null ? formatSize(entry.size) : '—'
  const dateLabel = formatDate(entry.modifiedAt)

  return (
    <XStack
      paddingHorizontal={16}
      paddingVertical={8}
      alignItems="center"
      gap={10}
      cursor="pointer"
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      pressStyle={{ opacity: 0.7 }}
      borderBottomWidth={1}
      borderBottomColor={c.border}
      onPress={handlePress}
    >
      {/* Icon */}
      <XStack width={20} alignItems="center" justifyContent="center" flexShrink={0}>
        {isDir ? (
          <Folder size={16} color={semanticColors.amber} />
        ) : (
          <File size={16} color={c.text3} />
        )}
      </XStack>

      {/* Name */}
      <Text
        flex={1}
        fontSize={13}
        color={isDir ? c.text : c.text2}
        numberOfLines={1}
        fontFamily={isDir ? '$body' : '$mono'}
      >
        {entry.name}
      </Text>

      {/* Size */}
      <Text
        fontSize={11}
        color={c.text3}
        fontFamily="$body"
        width={64}
        textAlign="right"
        flexShrink={0}
        // @ts-ignore — web only
        userSelect="none"
      >
        {sizeLabel}
      </Text>

      {/* Modified date */}
      <Text
        fontSize={11}
        color={c.text3}
        fontFamily="$body"
        width={90}
        textAlign="right"
        flexShrink={0}
        // @ts-ignore — web only
        userSelect="none"
      >
        {dateLabel}
      </Text>
    </XStack>
  )
}
