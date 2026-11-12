/**
 * FileBrowserBreadcrumb — Clickable breadcrumb bar for path navigation
 *
 * Displays the current path as clickable segments (e.g. /workspace / src / components).
 * Clicking any segment navigates to that directory.
 * Includes a back button that navigates to the previous entry in history.
 *
 * Look: the OS prototype's window header strip (`.phead`) — a round back
 * IconBtn, mono path segments with caret separators, the last one lifted.
 */

import React from "react"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { IconBtn, Ph, T, usePagePadding } from "../../components/ui/ds"

// ============================================================================
// Types
// ============================================================================

interface Props {
  currentPath: string
  canGoBack: boolean
  onNavigate: (path: string) => void
  onBack: () => void
  /** Optional right-hand note (e.g. "3 carpetas · 12 archivos"). */
  summary?: string
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
  const parts = path.split("/").filter(Boolean)
  return parts.map((part, index) => ({
    label: part,
    path: "/" + parts.slice(0, index + 1).join("/"),
  }))
}

// ============================================================================
// Component
// ============================================================================

export function FileBrowserBreadcrumb({
  currentPath,
  canGoBack,
  onNavigate,
  onBack,
  summary,
}: Props) {
  const c = useColors()
  const pad = usePagePadding()
  const segments = parseBreadcrumbs(currentPath)

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 56,
        paddingHorizontal: pad.h,
        paddingTop: 12,
        paddingBottom: 4,
        backgroundColor: c.bgSheet,
      }}
    >
      {/* Back button */}
      <IconBtn
        icon="caret-left"
        plain
        sm
        disabled={!canGoBack}
        onPress={canGoBack ? onBack : undefined}
        accessibilityLabel="Back"
        testID="file-browser-back"
      />

      {/* Scrollable path segments */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "center", flexDirection: "row" }}
        style={{ flex: 1 }}
      >
        <Ph name="folder-open" size={14} color={c.text3} style={{ marginRight: 6 }} />
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1

          return (
            <View key={segment.path} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              {/* Separator chevron (not before the first segment) */}
              {index > 0 && <Ph name="caret-right" size={11} color={c.text3} />}

              {/* Segment label */}
              <Pressable
                disabled={isLast}
                onPress={!isLast ? () => onNavigate(segment.path) : undefined}
                accessibilityRole={isLast ? undefined : "button"}
                testID={`file-breadcrumb-${segment.path}`}
                style={({ pressed, hovered }: any) => [
                  {
                    height: 26,
                    paddingHorizontal: 8,
                    borderRadius: 100,
                    justifyContent: "center",
                    backgroundColor: isLast ? c.bgStep : hovered ? c.wash : "transparent",
                  },
                  Platform.OS === "web"
                    ? ({
                        cursor: isLast ? "default" : "pointer",
                        userSelect: "none",
                        transition: "background 0.2s",
                        boxShadow: isLast ? c.liftSm : "none",
                      } as any)
                    : null,
                  pressed && !isLast ? { opacity: 0.7 } : null,
                ]}
              >
                <T step="code" tone={isLast ? "text" : "text2"}>
                  {segment.label}
                </T>
              </Pressable>
            </View>
          )
        })}
      </ScrollView>

      {summary ? (
        <T step="codenote" tone="text3">
          {summary}
        </T>
      ) : null}
    </View>
  )
}
