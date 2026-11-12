/**
 * Teros provider window — the admin zone that decides, per Teros provider
 * config, which upstream and model serve each size (TPROV-REQ-10). Admin only.
 *
 * @spec TPROV-REQ-10
 */
import { Cpu } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const TerosProviderWindowContent = lazyWithRetry(() =>
  import("./TerosProviderWindowContent").then((m) => ({ default: m.TerosProviderWindowContent })),
)

export interface TerosProviderWindowProps {
  /** Config to focus on open (optional). */
  configId?: string
}

/** @spec TPROV-REQ-10 */
export const terosProviderWindowDefinition: WindowTypeDefinition<TerosProviderWindowProps> = {
  type: "teros-provider",
  audience: "admin",
  displayName: "Teros provider",
  icon: Cpu,
  phIcon: "cpu",
  color: "#7C5CFF",
  component: TerosProviderWindowContent,
  defaultSize: { width: 820, height: 760 },
  minSize: { width: 520, height: 420 },
  isLauncher: true,
  allowMultiple: false,
  getTitle: () => i18n.t("windows.terosProvider"),
  getKey: () => "teros-provider",
  serialize: (props) => ({ configId: props.configId }),
  deserialize: (data) => ({ configId: data.configId }),
}
