import React from "react"
import { Platform } from "react-native"
import { styled, Text } from "tamagui"

/**
 * The chat pane geometry (OS prototype `@container pane`): ChatView measures
 * itself and the thread/header/composer read `compact` (pane ≤ 620px) to
 * switch to the mobile density. Default = desktop.
 */
export interface ChatPaneLayout {
  width: number
  /** Pane ≤ 620px — mobile density (header 12/14, thread 20/16, avatar 40). */
  compact: boolean
  /** Pane ≤ 460px — the tightest step (no role, bubble 90%). */
  narrow: boolean
}
export const ChatPaneContext = React.createContext<ChatPaneLayout>({
  width: 0,
  compact: false,
  narrow: false,
})
export const useChatPane = (): ChatPaneLayout => React.useContext(ChatPaneContext)

/** Thread measures (`.thread` / `.thread-in`). */
export const THREAD_MAX_WIDTH = 760
export const threadPadH = (pane: ChatPaneLayout): number =>
  pane.narrow ? 12 : pane.compact ? 16 : 28

// Selectable Text component for better copy-paste
export const SelectableText = styled(Text, {
  // @ts-ignore - userSelect is valid for web
  userSelect: Platform.OS === "web" ? "text" : undefined,
  cursor: Platform.OS === "web" ? "text" : undefined,
})
