/**
 * MCAs window wrapper — owns the tab navigation chrome (Phase 2).
 *
 * Renders a segmented-control tab bar ABOVE the content surface (so it stays visible
 * while the Management view loads/errors), then conditionally renders the unchanged
 * Management view (McasWindowContent) or the MCA Status placeholder. The inactive tab
 * is unmounted (conditional render). All copy is i18n-driven; no new dependency — the
 * tab bar is built from Tamagui XStack + Buttons.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, XStack, YStack } from "tamagui"
import { McaStatusDashboard } from "./McaStatusDashboard"
import { McasWindowContent } from "./McasWindowContent"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"

type Tab = "management" | "status"

export function McasWindow({ windowId }: { windowId: string }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>("management")
  const c = useColors()

  return (
    <YStack flex={1} backgroundColor="$background">
      <XStack
        backgroundColor={c.bgInner}
        borderRadius="$4"
        borderWidth={1}
        borderColor={c.border}
        padding="$2"
        gap="$2"
      >
        <Button
          size="$3"
          backgroundColor={tab === "management" ? semanticColors.indigoGlow : c.bgInner}
          borderWidth={1}
          borderColor={tab === "management" ? semanticColors.indigo : c.borderStrong}
          color={tab === "management" ? semanticColors.indigo : "$gray11"}
          fontWeight={tab === "management" ? "600" : "500"}
          hoverStyle={tab === "management" ? undefined : { backgroundColor: c.bgCardHover }}
          pressStyle={{ opacity: 0.8 }}
          onPress={() => setTab("management")}
        >
          {t("mca.status.tabManagement")}
        </Button>
        <Button
          size="$3"
          backgroundColor={tab === "status" ? semanticColors.indigoGlow : c.bgInner}
          borderWidth={1}
          borderColor={tab === "status" ? semanticColors.indigo : c.borderStrong}
          color={tab === "status" ? semanticColors.indigo : "$gray11"}
          fontWeight={tab === "status" ? "600" : "500"}
          hoverStyle={tab === "status" ? undefined : { backgroundColor: c.bgCardHover }}
          pressStyle={{ opacity: 0.8 }}
          onPress={() => setTab("status")}
        >
          {t("mca.status.tabStatus")}
        </Button>
      </XStack>
      {tab === "management" ? <McasWindowContent windowId={windowId} /> : <McaStatusDashboard />}
    </YStack>
  )
}
