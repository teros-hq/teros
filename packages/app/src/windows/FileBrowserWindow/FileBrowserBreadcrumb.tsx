/**
 * FileBrowserBreadcrumb — Clickable breadcrumb bar for path navigation
 *
 * Displays the current path as clickable segments (e.g. /workspace / src / components).
 * Clicking any segment navigates to that directory.
 * Includes a back button that navigates to the previous entry in history.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border tokens.
 * - Uses Tamagui font tokens (`$mono`).
 */

import { ChevronLeft, ChevronRight } from '@tamagui/lucide-icons'
import React from 'react'
import { ScrollView } from 'react-native'
import { Text, XStack } from 'tamagui'
import { useColors } from '../../components/mca/primitives/useColors'

// ============================================================================
// Types
// ============================================================================

interface Props {
  currentPath: string
  canGoBack: boolean
  onNavigate: (path: string) => void
  onBack: () => void
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a path into breadcrumb segments.
 * Each segment has a label and the absolute path it represents.
 *
 * e.g. '/workspace/src/components' →
 *   [{ label: 'workspace', path: '/workspace' },
 *    { label: 'src',       path: '/workspace/src' },
 *    { label: 'components', path: '/workspace/src/components' }]
 */
function parseBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  // Split and filter empty parts
  const parts = path.split('/').filter(Boolean)
  return parts.map((part, index) => ({
    label: part,
    path: '/' + parts.slice(0, index + 1).join('/'),
  }))
}

// ============================================================================
// Component
// ============================================================================

export function FileBrowserBreadcrumb({ currentPath, canGoBack, onNavigate, onBack }: Props) {
  const c = useColors()
  const segments = parseBreadcrumbs(currentPath)

  return (
    <XStack
      backgroundColor={c.bgCard}
      paddingHorizontal={12}
      paddingVertical={6}
      alignItems="center"
      gap={4}
      borderBottomWidth={1}
      borderBottomColor={c.borderStrong}
      minHeight={36}
    >
      {/* Back button */}
      <XStack
        paddingHorizontal={6}
        paddingVertical={4}
        borderRadius={4}
        alignItems="center"
        opacity={canGoBack ? 1 : 0.3}
        cursor={canGoBack ? 'pointer' : 'default'}
        hoverStyle={canGoBack ? { backgroundColor: c.bgCardHover } : undefined}
        pressStyle={canGoBack ? { opacity: 0.7 } : undefined}
        onPress={canGoBack ? onBack : undefined}
        flexShrink={0}
      >
        <ChevronLeft size={14} color={c.text3} />
      </XStack>

      {/* Scrollable path segments */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: 'center', flexDirection: 'row' }}
        style={{ flex: 1 }}
      >
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1
          const isRoot = segment.path === '/workspace'

          return (
            <XStack key={segment.path} alignItems="center" gap={2}>
              {/* Separator chevron (not before the first segment) */}
              {index > 0 && (
                <ChevronRight size={12} color={c.text3} />
              )}

              {/* Segment label */}
              <Text
                fontSize={12}
                color={isLast ? c.text : c.text2}
                fontFamily="$mono"
                paddingHorizontal={4}
                paddingVertical={2}
                borderRadius={4}
                cursor={isLast ? 'default' : 'pointer'}
                hoverStyle={
                  !isLast
                    ? { backgroundColor: c.bgCardHover, color: c.text2 }
                    : undefined
                }
                pressStyle={!isLast ? { opacity: 0.7 } : undefined}
                onPress={!isLast ? () => onNavigate(segment.path) : undefined}
                // @ts-ignore — web only
                userSelect="none"
              >
                {segment.label}
              </Text>
            </XStack>
          )
        })}
      </ScrollView>
    </XStack>
  )
}
