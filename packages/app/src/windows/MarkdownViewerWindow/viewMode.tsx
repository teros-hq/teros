/**
 * Formatted / source toggle of the Markdown viewer window
 * (docs/specs/todo/output-window.md, TODOOV-REQ-10).
 *
 * The mode is plain component state: per window instance, default
 * formatted, never persisted. Both sources (file and To Do) use it through
 * the shared ViewerFrame; share / download / refresh do not read it.
 */

import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Text, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { FONT_MONO } from "../../components/mca/primitives/fonts"
import { IconBtn } from "../../components/ui/ds"

/** @spec TODOOV-REQ-10 */
export type ViewMode = "formatted" | "source"

/** @spec TODOOV-REQ-10 — per-window, not persisted, default formatted. */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>("formatted")
  return [mode, setMode]
}

/** @spec TODOOV-REQ-10 — two icon buttons, the active one in the accent colour. */
export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const { t } = useTranslation()
  const formatted = t("markdownViewer.view.formatted")
  const source = t("markdownViewer.view.source")
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <IconBtn
        icon="text-aa"
        plain
        sm
        on={mode === "formatted"}
        onPress={() => onChange("formatted")}
        accessibilityLabel={formatted}
        aria-selected={mode === "formatted"}
        title={formatted}
        testID="markdown-view-formatted"
      />
      <IconBtn
        icon="code"
        plain
        sm
        on={mode === "source"}
        onPress={() => onChange("source")}
        accessibilityLabel={source}
        aria-selected={mode === "source"}
        title={source}
        testID="markdown-view-source"
      />
    </View>
  )
}

/** @spec TODOOV-REQ-10 — the raw markdown, mono 13 / 20, selectable and wrapping, on the sheet. */
export function MarkdownSource({ content }: { content: string }) {
  const c = useColors()
  return (
    <View
      style={{
        // Same sheet padding and measure as the rendered page (.md-content).
        paddingTop: 28,
        paddingHorizontal: 32,
        paddingBottom: 48,
        maxWidth: 860,
        width: "100%",
        alignSelf: "center",
        backgroundColor: c.bgSheet,
      }}
    >
      <Text
        selectable
        testID="markdown-source"
        style={[
          { fontFamily: FONT_MONO, fontSize: 13, lineHeight: 20, color: c.text },
          Platform.OS === "web" ? ({ whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" } as object) : null,
        ]}
      >
        {content}
      </Text>
    </View>
  )
}
