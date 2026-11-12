import React from "react"
import { AppRegistry, View, Text } from "react-native"
import { TamaguiProvider } from "tamagui"
import config from "../../tamagui.config"
import { SAMPLE } from "./sample"
import { ChangelogMarkdownRenderer as LegacyChangelogRenderer } from "./LegacyChangelog"
import { ChangelogMarkdownRenderer } from "../components/WhatsNewModal/ChangelogMarkdownRenderer"
import { LegacyCompact } from "./LegacyCompact"
import { CompactMarkdown } from "../windows/BoardWindow/CompactMarkdown"
import { MarkdownContent as LegacyChat } from "./LegacyChat"
import { MarkdownContent as ChatContent } from "../components/chat/bubbles/MarkdownContent"
import { Markdown as LegacyTodo } from "./LegacyTodo"
import { Markdown as TodoMarkdown } from "../windows/TodoWindow/ui/Markdown"
import { MarkdownRenderer as LegacyViewer } from "./LegacyViewer"
import { MarkdownRenderer as ViewerRenderer } from "../windows/MarkdownViewerWindow/components/MarkdownRenderer"
const q = new URLSearchParams(location.search)
const theme = (q.get("t") || "light") as "light" | "dark"
const surface = q.get("s") || "changelog"
function App() {
  const Old: any = surface === "board" ? LegacyCompact : surface === "viewer" ? LegacyViewer : surface === "todo" ? LegacyTodo : surface === "chat" ? LegacyChat : LegacyChangelogRenderer
  const New: any = surface === "board" ? CompactMarkdown : surface === "viewer" ? ViewerRenderer : surface === "todo" ? TodoMarkdown : surface === "chat" ? ChatContent : ChangelogMarkdownRenderer
  const props: any = surface === "board" ? { text: SAMPLE } : surface === "chat" ? { text: SAMPLE, variant: "prose" } : surface === "todo" ? { source: SAMPLE } : { content: SAMPLE }
  return (
    <TamaguiProvider config={config} defaultTheme={theme}>
      <View style={{ flexDirection: "row", gap: 24, padding: 16, backgroundColor: theme === "dark" ? "#0b0b10" : "#fff" }}>
        <View style={{ width: 520 }}><Text style={{ fontWeight: "700", marginBottom: 8 }}>ANTES (legacy)</Text><Old {...props} /></View>
        <View style={{ width: 520 }}><Text style={{ fontWeight: "700", marginBottom: 8 }}>DESPUÉS (unificado)</Text><New {...props} /></View>
      </View>
    </TamaguiProvider>
  )
}
AppRegistry.registerComponent("App", () => App)
AppRegistry.runApplication("App", { rootTag: document.getElementById("root") })
