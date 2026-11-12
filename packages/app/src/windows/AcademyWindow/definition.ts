/**
 * Academy Window Type Definition (TER-716)
 * Phase-grouped catalog of embedded YouTube videotutorials.
 */
import { GraduationCap } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const AcademyWindowContent = lazyWithRetry(() =>
  import("./AcademyWindowContent").then((m) => ({ default: m.AcademyWindowContent })),
)

export interface AcademyWindowProps {
  /** Pre-selected workspace ID (optional, falls back to active workspace) */
  workspaceId?: string
}

export const academyWindowDefinition: WindowTypeDefinition<AcademyWindowProps> = {
  type: "academy",
  audience: "user",
  displayName: "Academy",
  icon: GraduationCap,
  phIcon: "graduation-cap",
  color: "#5E6AD2",
  component: AcademyWindowContent,

  defaultSize: { width: 960, height: 680 },
  minSize: { width: 420, height: 320 },

  isLauncher: true,

  // Gated by academy.enabled — the catalog ships placeholder videos (TER-716)
  featureFlag: "academy.enabled",

  getTitle: () => i18n.t("windows.academy"),

  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId }),
  /** @spec NAV-REQ-21 */
  portable: () => ({}),
}
