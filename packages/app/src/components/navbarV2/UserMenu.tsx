/**
 * UserMenu — the person's menu at the bottom of the rail: account entries for
 * everyone, the Administration group for admin/super (NAV-REQ-13). It replaces
 * the Account and Admin sections of the previous navbar.
 *
 * @spec NAV-REQ-13
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useBillingStore } from "../../store/billingStore"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"
import { useColors } from "../mca/primitives/useColors"
import { fx } from "../../styles/fx"
import { CountPill, Ph } from "../ui/ds"
import { EXPANDED_WIDTH, useNavbarStyles } from "./primitives"

export interface UserMenuProps {
  /** Distance from the bottom of the viewport (web) / of the sidebar. */
  bottom: number
  collapsed?: boolean
  isAdmin: boolean
  onClose: () => void
  onOpen: (type: string, props?: Record<string, any>) => void
  onWhatsNew?: () => void
  onLogout?: () => void
}

/** @spec NAV-REQ-13 */
export function UserMenu(p: UserMenuProps) {
  const { t } = useTranslation()
  const c = useColors()
  const styles = useNavbarStyles()
  const theme = useUiPreferencesStore((s) => s.theme)
  const toggleTheme = useUiPreferencesStore((s) => s.toggleTheme)
  const pendingBillingRequests = useBillingStore((s) => s.pendingAdminRequests)

  const Item = ({
    icon,
    label,
    onPress,
    meta,
    trailing,
    testID,
  }: {
    icon: string
    label: string
    onPress: () => void
    meta?: string
    trailing?: React.ReactNode
    testID?: string
  }) => (
    <Pressable
      testID={testID}
      style={({ hovered, pressed }: any) => [styles.menuItem, (hovered || pressed) && styles.menuItemHover]}
      onPress={() => {
        onPress()
        p.onClose()
      }}
    >
      <Ph name={icon} size={14} color={c.text3} />
      <Text style={styles.menuItemText} numberOfLines={1}>
        {label}
      </Text>
      {meta ? <Text style={styles.menuItemMeta}>{meta}</Text> : null}
      {trailing}
    </Pressable>
  )

  return (
    <Modal visible transparent animationType="none" onRequestClose={p.onClose}>
      <Pressable style={[styles.menuBackdrop, { position: "absolute" }]} onPress={p.onClose} testID="user-menu-backdrop" />
      <View
        {...fx("menu")}
        testID="user-menu"
        style={[
          styles.menu,
          { position: "absolute", top: "auto" as any, bottom: p.bottom, left: p.collapsed ? 72 : 12, width: EXPANDED_WIDTH - 24 },
        ]}
      >
        <ScrollView style={{ maxHeight: 440 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          <Item icon="user-circle" label={t("nav.profile")} onPress={() => p.onOpen("profile", { onLogout: p.onLogout })} testID="user-menu-profile" />
          <Item icon="cloud" label={t("nav.providers")} onPress={() => p.onOpen("providers")} />
          {/* WNEW-REQ-1: absent while whats-new.enabled is off */}
          {p.onWhatsNew && <Item icon="sparkle" label={t("nav.whatsNew")} onPress={p.onWhatsNew} />}
          <Item
            icon={theme === "dark" ? "sun" : "moon"}
            label={t("nav.theme")}
            meta={theme === "dark" ? t("nav.themeDark") : t("nav.themeLight")}
            onPress={toggleTheme}
          />
          {p.isAdmin ? (
            <>
              <View style={styles.menuHr} />
              <Text style={[styles.menuItemMeta, { paddingHorizontal: 10, paddingVertical: 4 }]}>
                {t("nav.administration").toUpperCase()}
              </Text>
              <Item icon="cpu" label={t("nav.agentCores")} onPress={() => p.onOpen("agent-cores")} />
              <Item icon="package" label={t("nav.mcas")} onPress={() => p.onOpen("mcas")} />
              <Item icon="users-three" label={t("nav.users")} onPress={() => p.onOpen("users")} testID="user-menu-users" />
              <Item icon="gauge" label={t("nav.monitoring")} onPress={() => p.onOpen("monitoring")} />
              <Item icon="lightning" label={t("nav.latitudeSignals")} onPress={() => p.onOpen("latitude-signals")} />
              <Item icon="flag" label={t("nav.featureFlags")} onPress={() => p.onOpen("feature-flags")} />
              <Item icon="cpu" label={t("nav.terosProvider")} onPress={() => p.onOpen("teros-provider")} testID="user-menu-teros-provider" />
              <Item
                icon="credit-card"
                label={t("nav.billingRequests")}
                onPress={() => p.onOpen("billing-requests")}
                trailing={pendingBillingRequests > 0 ? <CountPill n={pendingBillingRequests > 99 ? "99+" : pendingBillingRequests} /> : undefined}
              />
              <Item icon="buildings" label={t("nav.billingTeams")} onPress={() => p.onOpen("billing-teams")} />
            </>
          ) : null}
          {p.onLogout ? (
            <>
              <View style={styles.menuHr} />
              <Item icon="sign-out" label={t("nav.signOut")} onPress={() => p.onLogout?.()} testID="user-menu-signout" />
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  )
}
