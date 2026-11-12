/**
 * Console Window Type Definition
 */

import { Terminal } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const ConsoleWindowContent = lazyWithRetry(() =>
  import("./ConsoleWindowContent").then((m) => ({ default: m.ConsoleWindowContent })),
)

export type ConsoleWindowProps = {}

export const consoleWindowDefinition: WindowTypeDefinition<ConsoleWindowProps> = {
  type: "console",
  audience: "admin",
  displayName: "Console",
  icon: Terminal,
  phIcon: "terminal-window",
  color: "#6F27FF",
  component: ConsoleWindowContent,

  defaultSize: { width: 600, height: 400 },
  minSize: { width: 300, height: 200 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.console"),

  serialize: () => ({}),
  deserialize: () => ({}),
}
