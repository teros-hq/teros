/**
 * Home Window — the "Inicio" tab of the OS prototype (design-testing).
 *
 * One per workspace: greeting hero + ask box, pending approvals, the team
 * right now, projects with progress, and a small pulse.
 */

import { House } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { WindowTypeDefinition } from "../../services/windowRegistry"

const HomeWindowContent = lazyWithRetry(() =>
  import("./HomeWindowContent").then((m) => ({ default: m.HomeWindowContent })),
)

export interface HomeWindowProps {
  workspaceId?: string
}

export const homeWindowDefinition: WindowTypeDefinition<HomeWindowProps> = {
  type: "home",
  audience: "user",
  displayName: "Home",
  icon: House,
  phIcon: "house",
  color: "#6F27FF",
  component: HomeWindowContent,

  defaultSize: { width: 1100, height: 760 },
  minSize: { width: 360, height: 480 },

  // Single instance — reopening focuses the existing tab.
  getKey: () => "home",
  allowMultiple: false,
  isLauncher: true,

  getTitle: () => i18n.t("home.title", { defaultValue: "Inicio" }),

  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId as string | undefined }),
}
