/**
 * Conversations Window Type Definition
 *
 * Lista de conversaciones con agentes, similar al sidebar pero como ventana movible.
 */

import { MessageCircle } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const ConversationsWindowContent = lazyWithRetry(() =>
  import("./ConversationsWindowContent").then((m) => ({ default: m.ConversationsWindowContent })),
)
import i18n from "../../i18n"

export interface ConversationsWindowProps {
  /** Workspace context */
  workspaceId?: string
  /** Filtro inicial: 'active' | 'inactive' | 'archived' | 'all' */
  filter?: "active" | "inactive" | "archived" | "all"
}

export const conversationsWindowDefinition: WindowTypeDefinition<ConversationsWindowProps> = {
  type: "conversations",
  audience: "user",
  displayName: "Conversaciones",
  icon: MessageCircle,
  phIcon: "chats-circle",
  color: "#4A9BA8",
  component: ConversationsWindowContent,

  defaultSize: { width: 280, height: 500 },
  minSize: { width: 200, height: 300 },

  isLauncher: true,

  getTitle: (props) => {
    switch (props.filter) {
      case "inactive":
        return i18n.t("windows.conversationsInactive")
      case "archived":
        return i18n.t("windows.conversationsArchived")
      case "all":
        return i18n.t("windows.conversationsAll")
      default:
        return i18n.t("windows.conversations")
    }
  },

  serialize: (props) => ({ workspaceId: props.workspaceId, filter: props.filter }),
  deserialize: (data) => ({ workspaceId: data.workspaceId, filter: data.filter || "active" }),
  /** @spec NAV-REQ-21 — the list travels; a single conversation never does. */
  portable: (props) => ({ filter: props.filter }),
}
