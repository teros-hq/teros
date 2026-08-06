/**
 * FileBrowserWindowContent — Root component for the File Browser window
 *
 * Manages navigation state (currentPath + history) and delegates to:
 *  - FileBrowserBreadcrumb: breadcrumb bar with back button
 *  - useFileListing: fetch directory entries via fs.list
 *  - FileBrowserEntry: individual file/directory rows
 *
 * If workspaceId is not provided as a prop, the component automatically
 * uses the activeWorkspaceId from the workspace store.
 *
 * File-open behaviour:
 *  - .md files: calls openFile() from fileOpener; shows toast if no handler registered
 *  - other files: shows toast "Opening this file type is not supported yet."
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for error/warning accents (red, amber).
 * - Uses Tamagui font tokens (`$body`).
 */

import { AlertCircle, RefreshCw } from '@tamagui/lucide-icons'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Text, XStack, YStack } from 'tamagui'
import { useToast } from '../../components/Toast'
import { openFile } from '../../services/fileOpener'
import type { FileEntry } from '../../services/FileBrowserApi'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { colors as semanticColors } from '../../components/mca/primitives/colors'
import { useColors } from '../../components/mca/primitives/useColors'
import { FileBrowserBreadcrumb } from './FileBrowserBreadcrumb'
import { FileBrowserEntry } from './FileBrowserEntry'
import { useFileListing } from './useFileListing'
import type { FileBrowserWindowProps } from './definition'

// ============================================================================
// Types
// ============================================================================

interface Props extends FileBrowserWindowProps {
  windowId: string
}

// ============================================================================
// Main component
// ============================================================================

export function FileBrowserWindowContent({ windowId, workspaceId: propWorkspaceId, initialPath }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const c = useColors()

  // Use the prop workspaceId if provided; otherwise fall back to the active workspace from the store
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const effectiveWorkspaceId = propWorkspaceId ?? activeWorkspaceId ?? ''

  // Navigation state
  const [currentPath, setCurrentPath] = useState(initialPath ?? '/workspace')
  const [history, setHistory] = useState<string[]>([])

  // Directory listing for the current path (only active when we have a workspaceId)
  const { status, entries, truncated, error, retry } = useFileListing(
    effectiveWorkspaceId,
    currentPath,
  )

  // ── Navigation ──────────────────────────────────────────────────────────────

  const navigateTo = useCallback((path: string) => {
    setHistory((prev) => [...prev, currentPath])
    setCurrentPath(path)
  }, [currentPath])

  const navigateBack = useCallback(() => {
    if (history.length === 0) return
    const previous = history[history.length - 1]
    setHistory((prev) => prev.slice(0, -1))
    setCurrentPath(previous)
  }, [history])

  // ── File opening ────────────────────────────────────────────────────────────

  const handleOpenFile = useCallback((entry: FileEntry) => {
    const handled = openFile(entry.path, effectiveWorkspaceId)
    if (!handled) {
      toast.info('No viewer available for this file type.')
    }
  }, [effectiveWorkspaceId, toast])



  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Breadcrumb */}
      <FileBrowserBreadcrumb
        currentPath={currentPath}
        canGoBack={history.length > 0}
        onNavigate={navigateTo}
        onBack={navigateBack}
      />

      {/* Column header */}
      <XStack
        paddingHorizontal={16}
        paddingVertical={6}
        borderBottomWidth={1}
        borderBottomColor={c.border}
        backgroundColor={c.bgInner}
      >
        <Text
          flex={1}
          fontSize={10}
          color={c.text3}
          fontFamily="$body"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          Name
        </Text>
        <Text
          fontSize={10}
          color={c.text3}
          fontFamily="$body"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing={0.5}
          width={64}
          textAlign="right"
        >
          Size
        </Text>
        <Text
          fontSize={10}
          color={c.text3}
          fontFamily="$body"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing={0.5}
          width={90}
          textAlign="right"
        >
          Modified
        </Text>
      </XStack>

      {/* Loading state */}
      {status === 'loading' && (
        <YStack flex={1} alignItems="center" justifyContent="center" gap={12}>
          <Text color={c.text3} fontSize={13} fontFamily="$body">
            Loading…
          </Text>
        </YStack>
      )}

      {/* Error state */}
      {status === 'error' && (
        <YStack flex={1} alignItems="center" justifyContent="center" padding={24} gap={12}>
          <AlertCircle size={32} color={semanticColors.red} />
          <Text color={semanticColors.red} fontSize={13} fontFamily="$body" textAlign="center" maxWidth={320}>
            {error ?? t('errors.fileBrowser.loadFailed')}
          </Text>
          <Button
            size="$3"
            onPress={retry}
            icon={<RefreshCw size={13} />}
            backgroundColor={c.badges.err.bg}
            borderColor={c.badges.err.border}
            color={semanticColors.red}
          >
            Retry
          </Button>
        </YStack>
      )}

      {/* Empty state */}
      {status === 'success' && entries.length === 0 && (
        <YStack flex={1} alignItems="center" justifyContent="center" padding={24}>
          <Text color={c.text3} fontSize={13} fontFamily="$body">
            This folder is empty.
          </Text>
        </YStack>
      )}

      {/* Entries */}
      {status === 'success' && entries.length > 0 && (
        <YStack
          flex={1}
          // minHeight: 0 is required for flex children in web to scroll correctly.
          // Without it, the YStack expands to fit all content instead of scrolling.
          // @ts-ignore — web-only CSS property
          style={{ overflowY: 'auto', minHeight: 0 }}
        >
          {entries.map((entry) => (
            <FileBrowserEntry
              key={entry.path}
              entry={entry}
              onNavigate={navigateTo}
              onOpenFile={handleOpenFile}
            />
          ))}

          {/* Truncation notice */}
          {truncated && (
            <XStack
              paddingHorizontal={16}
              paddingVertical={10}
              backgroundColor={c.badges.warn.bg}
              borderTopWidth={1}
              borderTopColor={c.badges.warn.border}
            >
              <Text fontSize={11} color={c.badges.warn.text} fontFamily="$body" textAlign="center" flex={1}>
                Showing first 1,000 entries. The directory contains more files.
              </Text>
            </XStack>
          )}
        </YStack>
      )}
    </YStack>
  )
}
