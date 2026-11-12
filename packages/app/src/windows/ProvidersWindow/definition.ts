/**
 * Providers Window Type Definition
 *
 * Admin window to view and manage LLM providers and their models.
 */

import { Cloud } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const ProvidersWindowContent = lazyWithRetry(() =>
  import("./ProvidersWindowContent").then((m) => ({ default: m.ProvidersWindowContent })),
)

export type ProvidersWindowProps = {}

export const providersWindowDefinition: WindowTypeDefinition<ProvidersWindowProps> = {
  type: "providers",
  audience: "user",
  displayName: "Providers",
  icon: Cloud,
  phIcon: "cloud",
  color: "#C75450",
  component: ProvidersWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.myProviders"),
  getSubtitle: () => i18n.t("windows.myProvidersSub"),

  serialize: () => ({}),
  deserialize: () => ({}),
}
