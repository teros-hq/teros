/**
 * MarkdownRenderer — the file-viewer surface of the unified markdown renderer
 * (MD-UNIFY v2, step 3). Thin wrapper over the `document` variant of
 * components/markdown: Saans body + Prody headings, external images blocked,
 * Prism code on web, `~` literal (policy in @teros/shared/markdown).
 *
 * This file only owns the page frame the viewer had before unification — web:
 * centred 860px column on the sheet background; native: a ScrollView with 20px
 * padding. Public API unchanged: <MarkdownRenderer content={...} /> (the viewer
 * window and the chat file body call it untouched).
 */
import React from "react"
import { Platform, ScrollView, View } from "react-native"

import { Markdown } from "../../../components/markdown"
import { useColors } from "../../../components/mca/primitives/useColors"

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const c = useColors()

  if (Platform.OS === "web") {
    return (
      <View
        style={{
          width: "100%",
          maxWidth: 860,
          alignSelf: "center",
          backgroundColor: c.bgSheet,
          paddingTop: 28,
          paddingHorizontal: 32,
          paddingBottom: 48,
        }}
      >
        <Markdown text={content} variant="document" />
      </View>
    )
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bgSheet }} contentContainerStyle={{ padding: 20 }}>
      <Markdown text={content} variant="document" />
    </ScrollView>
  )
}
