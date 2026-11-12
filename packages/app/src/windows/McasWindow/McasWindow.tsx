/**
 * MCAs window wrapper — owns the page head + tab navigation chrome (Phase 2).
 *
 * Renders the OS-prototype page head (eyebrow · serif title · lead) with the Controls / Health
 * `PTabs` as its action, ABOVE the content surface (so it stays visible while the Management view
 * loads/errors), then conditionally renders the Management view (McasWindowContent) or the MCA
 * Status dashboard. The inactive tab is unmounted (conditional render). All copy is i18n-driven.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { McaStatusDashboard } from "./McaStatusDashboard"
import { McasWindowContent } from "./McasWindowContent"
import { useColors } from "../../components/mca/primitives/useColors"
import { PageHead, PTabs, usePagePadding } from "../../components/ui/ds"

type Tab = "management" | "status"

export function McasWindow({ windowId }: { windowId: string }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>("management")
  const c = useColors()
  const p = usePagePadding()

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      <View
        style={{
          paddingHorizontal: p.h,
          paddingTop: p.t,
          width: "100%",
          maxWidth: 1072,
          alignSelf: "center",
        }}
      >
        <PageHead
          eyebrow={t("mcas.eyebrow", { defaultValue: "MCAs" })}
          title={t("windows.mcaCatalog")}
          lead={t("windows.mcaCatalogSub")}
          actions={
            <PTabs<Tab>
              value={tab}
              onChange={setTab}
              items={[
                {
                  key: "management",
                  label: t("mca.status.tabManagement"),
                  icon: "sliders-horizontal",
                },
                { key: "status", label: t("mca.status.tabStatus"), icon: "heartbeat" },
              ]}
            />
          }
        />
      </View>
      {tab === "management" ? <McasWindowContent windowId={windowId} /> : <McaStatusDashboard />}
    </View>
  )
}
