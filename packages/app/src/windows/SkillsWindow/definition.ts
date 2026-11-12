/**
 * Skills Window Type Definition
 *
 * CRUD interface for workspace-level skills (reusable instruction blocks for agents).
 */

import { BookOpen } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const SkillsWindowContent = lazyWithRetry(() =>
  import("./SkillsWindowContent").then((m) => ({ default: m.SkillsWindowContent })),
)

export interface SkillsWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
}

export const skillsWindowDefinition: WindowTypeDefinition<SkillsWindowProps> = {
  type: "skills",
  audience: "user",
  displayName: "Skills",
  icon: BookOpen,
  phIcon: "books",
  color: "#0D9488",
  component: SkillsWindowContent,

  defaultSize: { width: 860, height: 620 },
  minSize: { width: 420, height: 320 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.skills"),

  serialize: (props) => ({
    workspaceId: props.workspaceId,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
  }),
  /** @spec NAV-REQ-21 */
  portable: () => ({}),
}
