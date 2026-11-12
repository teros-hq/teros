/**
 * NavbarV2 — the rail with two anchored zones (NAV spec v2.0.0).
 *
 * The fixed chrome is the current navbar's, unchanged: brand, main-agent chip
 * with New chat, pending approvals, workspace selector on top; desktops, voice
 * presence and the person at the bottom. In between, where Agents · Projects ·
 * Conversations · Apps · Account · Admin used to be, the workspace zone (same
 * for every member, edited by owner/admins) and the personal zone.
 *
 * Rendered by NavbarShell when `navbar_v2` is on; Navbar.tsx is untouched.
 *
 * @spec NAV-REQ-1, NAV-REQ-9, NAV-REQ-13, NAV-REQ-14, NAV-REQ-15, NAV-REQ-17
 */
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useClickModifiers } from "../../hooks/useClickModifiers"
import { useNavbarRealtimeSync } from "../../hooks/navbar/useNavbarRealtimeSync"
import { useNavbarStore } from "../../store/navbarStore"
import { selectActiveContainerId, useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"
import { useFeatureFlagsStore } from "../../store/featureFlagsStore"
import { useToast } from "../Toast"
import { Avatar } from "../Avatar"
import { DesktopIndicator } from "../DesktopIndicator"
import { NewConversationModal } from "../NewConversationModal"
import { TerosLogo } from "../TerosLogo"
import { TerosWordmark } from "../TerosWordmark"
import { WorkspaceIcon } from "../WorkspaceIcon"
import { PermissionIndicator } from "../navbar/PermissionIndicator"
import { VoicePresenceBlock } from "../voice/VoicePresenceBlock"
import { FrameMelt } from "../workspace/FrameMelt"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { fx } from "../../styles/fx"
import { IconBtn, Ph, SelectField } from "../ui/ds"
import { Halo } from "../ui/ds/Halo"
import type { NavbarPinData, NavbarPinScope, NavbarPinWindow } from "../../services/NavbarApi"
import { isPinVisible, openProps, pinInputFromWindow, reorderPinIds, serializeWindowProps, splitZones, windowKey, WORKSPACE_LINK } from "./pinModel"
import { selectPins, subscribePinsRealtime, usePinsStore } from "./pinsStore"
import { PinMenu, PinPicker, type MenuAnchor } from "./PinMenu"
import { UserMenu } from "./UserMenu"
import { ZoneList } from "./ZoneList"
import { useRailDrop } from "./useRailDrop"
import {
  COLLAPSED_WIDTH,
  EXPANDED_WIDTH,
  findActiveWindowId,
  MOBILE_BREAKPOINT,
  RailBtn,
  ThemeToggleButton,
  useNavbarStyles,
} from "./primitives"

interface NavbarV2Props {
  userName?: string
  userRole?: string
  onLogout?: () => void
  onWhatsNew?: () => void
  children?: React.ReactNode
}

type MenuState =
  | { kind: "pin"; pin: NavbarPinData; anchor: MenuAnchor }
  | { kind: "picker"; zone: NavbarPinScope; anchor: MenuAnchor }
  | { kind: "user" }
  | null

/** @spec NAV-REQ-1 */
export function NavbarV2({ userName = "User", userRole = "user", onLogout, onWhatsNew, children }: NavbarV2Props) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useUiPreferencesStore((st) => st.theme) === "dark"
  const styles = useNavbarStyles()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const { shouldOpenInNewTab } = useClickModifiers()

  const {
    agents,
    workspaces,
    isLoaded,
    isExpanded,
    isMobileMenuOpen,
    setAgents,
    setWorkspaces,
    setLoaded,
    setExpanded,
    setMobileMenuOpen,
    loadExpandedState,
  } = useNavbarStore()
  const { openWindow } = useTilingStore()
  const { activeWorkspaceId, setActiveWorkspace, hydrateActiveWorkspace } = useWorkspaceStore()

  // ── Pins (server-backed) ────────────────────────────────────────────────
  const pins = usePinsStore(selectPins(activeWorkspaceId))
  const loadPins = usePinsStore((s) => s.load)
  useEffect(() => {
    if (activeWorkspaceId) void loadPins(activeWorkspaceId)
  }, [activeWorkspaceId, loadPins])
  useEffect(() => subscribePinsRealtime(), [])
  const flags = useFeatureFlagsStore((s) => s.flags)
  const visiblePins = useMemo(() => pins.filter(isPinVisible), [pins, flags])
  const zones = useMemo(() => splitZones(visiblePins), [visiblePins])

  const activeWs = workspaces.find((ws) => ws.workspaceId === activeWorkspaceId)
  const canEditWorkspaceZone = activeWs?.role === "owner" || activeWs?.role === "admin"
  const isAdmin = userRole === "admin" || userRole === "super"
  const isMobile = width < MOBILE_BREAKPOINT

  // ── Agents + workspaces (the chip, the selector, voice) ────────────────
  useEffect(() => {
    loadExpandedState()
  }, [])

  useEffect(() => {
    let mounted = true
    const loadData = async () => {
      if (isLoaded) return
      try {
        const globalAgents = await client.agent.listAgents().then((r) => r.agents)
        const { workspaces: userWorkspaces } = await client.workspace.listWorkspaces()
        const mapped = userWorkspaces.map((ws: any) => ({
          workspaceId: ws.workspaceId,
          name: ws.name,
          role: ws.role,
          volumeId: ws.volumeId,
          appearance: ws.appearance,
          type: ws.type,
        }))
        if (mounted) {
          setWorkspaces(mapped)
          await hydrateActiveWorkspace()
          if (!useWorkspaceStore.getState().activeWorkspaceId) {
            const privateWs = mapped.find((ws: any) => ws.type === "private")
            if (privateWs) setActiveWorkspace(privateWs.workspaceId)
          }
        }
        const perWorkspace = await Promise.all(
          userWorkspaces.map((ws: any) => client.agent.listAgents(ws.workspaceId).then((r) => r.agents).catch(() => [])),
        )
        if (mounted) {
          const seen = new Set<string>()
          setAgents(
            [...globalAgents, ...perWorkspace.flat()]
              .map((a: any) => ({
                agentId: a.agentId,
                name: a.fullName || a.name,
                role: a.role,
                avatarUrl: a.avatarUrl,
                coreId: a.coreId,
                workspaceId: a.workspaceId,
              }))
              .filter((a) => (seen.has(a.agentId) ? false : (seen.add(a.agentId), true))),
          )
          setLoaded(true)
        }
      } catch (err) {
        console.error("[NavbarV2] load failed:", err)
      }
    }
    const handleConnected = () => {
      setLoaded(false)
      loadData()
    }
    if (client.isConnected() && !isLoaded) loadData()
    client.on("connected", handleConnected)
    client.on("authenticated", handleConnected)
    return () => {
      mounted = false
      client.off("connected", handleConnected)
      client.off("authenticated", handleConnected)
    }
  }, [isLoaded])

  useEffect(() => {
    if (activeWorkspaceId !== undefined) setLoaded(false)
  }, [activeWorkspaceId])

  useNavbarRealtimeSync()

  useEffect(() => {
    if (!isMobile && isMobileMenuOpen) setMobileMenuOpen(false)
  }, [isMobile])

  // ── Menus ───────────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuState>(null)
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false)
  const workspaceSelectorRef = useRef<View>(null)
  const [dropdownTop, setDropdownTop] = useState(48)
  useLayoutEffect(() => {
    if (showWorkspaceDropdown && workspaceSelectorRef.current && Platform.OS === "web") {
      workspaceSelectorRef.current.measureInWindow((_x, y, _w, h) => setDropdownTop(y + h + 4))
    }
  }, [showWorkspaceDropdown])

  // ── Scroll gradients ────────────────────────────────────────────────────
  const [scrollState, setScrollState] = useState({ canScrollUp: false, canScrollDown: false })
  const scrollViewRef = useRef<ScrollView>(null)
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    setScrollState({
      canScrollUp: contentOffset.y > 5,
      canScrollDown: contentOffset.y < contentSize.height - layoutMeasurement.height - 5,
    })
  }, [])
  const handleContentSizeChange = useCallback((_w: number, contentHeight: number) => {
    const current = scrollViewRef.current
    if (current && "measure" in current) {
      ;(current as any).measure((_x: number, _y: number, _width: number, height: number) => {
        setScrollState((prev) => ({ ...prev, canScrollDown: contentHeight > height }))
      })
    }
  }, [])

  // ── Derived ─────────────────────────────────────────────────────────────
  const superAgents = useMemo(() => agents.filter((a) => !a.workspaceId), [agents])
  const firstSuperAgent = superAgents[0]
  const extraSuperAgents = Math.max(0, superAgents.length - 1)
  const superFirstName = firstSuperAgent ? firstSuperAgent.name.split(" ")[0] : null
  const sortedWorkspaces = useMemo(
    () => [
      ...workspaces.filter((ws) => ws.type === "private"),
      ...[...workspaces.filter((ws) => ws.type !== "private")].sort((a, b) => a.name.localeCompare(b.name)),
    ],
    [workspaces],
  )
  const userInitials = userName.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("")
  const sidebarWidth = isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH

  // Active window → "on" state of a pin (same identity rule as the backend key).
  const activeContainerId = useTilingStore(selectActiveContainerId)
  const activeLayout = useTilingStore((s) => s.desktops[s.activeDesktopIndex]?.layout ?? null)
  const tilingWindows = useTilingStore((s) => s.windows)
  const activeKey = useMemo(() => {
    const id = findActiveWindowId(activeLayout, activeContainerId)
    const w = id ? tilingWindows[id] : null
    return w ? windowKey(w.type, serializeWindowProps(w.type, w.props ?? {})) : null
  }, [activeLayout, activeContainerId, tilingWindows])
  const isOn = useCallback((pin: NavbarPinData) => pin.window.type !== WORKSPACE_LINK && pin.key === activeKey, [activeKey])

  // ── Actions ─────────────────────────────────────────────────────────────
  const switchWorkspace = (workspaceId: string) => {
    // URL-first switch, like the workspace menu: WorkspaceShellInit drives the store.
    router.replace(`/workspace/${workspaceId}`)
  }

  /** @spec NAV-REQ-9 */
  const openPin = (pin: NavbarPinData, e?: any, forceNewTab = false) => {
    setMobileMenuOpen(false)
    if (!pin.enabled) return
    if (pin.window.type === WORKSPACE_LINK) {
      const target = pin.window.props?.workspaceId as string | undefined
      if (target) switchWorkspace(target)
      return
    }
    const inNewTab = forceNewTab || (e ? shouldOpenInNewTab(e) : false)
    openWindow(pin.window.type, openProps(pin), inNewTab)
  }

  const pinStore = usePinsStore.getState

  const anchor = async (zone: NavbarPinScope, input: { window: NavbarPinWindow; label: string; icon: string }, before?: string | null) => {
    if (!activeWorkspaceId) return
    try {
      const { existed, pin } = await pinStore().pin({
        workspaceId: activeWorkspaceId,
        scope: zone,
        window: input.window,
        label: input.label,
        icon: input.icon,
        position: before ? { before } : undefined,
      })
      if (existed) toast.info?.(t("nav.alreadyPinned"), input.label)
      else toast.success(t("nav.pinned"), zone === "workspace" ? t("nav.visibleToAll", { name: activeWs?.name ?? "" }) : t("nav.onlyYou"))
      return pin
    } catch (err: any) {
      toast.error(t("common.error"), err?.code === "ACCESS_DENIED" ? t("nav.zoneLocked") : (err?.message ?? String(err)))
    }
  }

  /** @spec NAV-REQ-19 — a dropped row is reordered in its zone or moved to the other one at that position. */
  const dropPin = async (zone: NavbarPinScope, beforeId: string | null, pinId: string) => {
    if (!activeWorkspaceId) return
    const pin = pins.find((x) => x.pinId === pinId)
    if (!pin) return
    const editable = zone === "workspace" ? !!canEditWorkspaceZone : true
    if (!editable) return
    // The whole zone, hidden (flag-gated) pins included, so they keep their slot.
    const all = splitZones(pins)
    const zoneIds = (zone === "workspace" ? all.workspace : all.personal).map((x) => x.pinId)
    try {
      if (pin.scope !== zone) {
        await pinStore().move(pinId, { scope: zone }, activeWorkspaceId)
        await pinStore().reorder(activeWorkspaceId, zone, reorderPinIds([...zoneIds, pinId], pinId, beforeId))
        return
      }
      const next = reorderPinIds(zoneIds, pinId, beforeId)
      if (next.join() === zoneIds.join()) return
      await pinStore().reorder(activeWorkspaceId, zone, next)
    } catch (err: any) {
      toast.error(t("common.error"), err?.code === "ACCESS_DENIED" ? t("nav.zoneLocked") : (err?.message ?? String(err)))
      void pinStore().load(activeWorkspaceId)
    }
  }

  /** @spec NAV-REQ-15 — phase 3: the dropped tab's window becomes a pin. */
  const { drop, setDropNode } = useRailDrop({
    onEnter: (kind) => {
      if (kind === "window" && !isExpanded) setExpanded(true)
    },
    onDrop: (zone, beforeId, windowId) => {
      const w = useTilingStore.getState().windows[windowId]
      if (!w) return
      void anchor(zone, pinInputFromWindow(w, t), beforeId)
    },
    onDropPin: (zone, beforeId, pinId) => void dropPin(zone, beforeId, pinId),
  })

  const onUnpin = async (pin: NavbarPinData) => {
    if (!activeWorkspaceId) return
    try {
      await pinStore().unpin(pin.pinId, activeWorkspaceId)
    } catch (err: any) {
      toast.error(t("common.error"), err?.message ?? String(err))
    }
  }
  const onMove = async (pin: NavbarPinData, to: { scope?: NavbarPinScope; global?: boolean }) => {
    if (!activeWorkspaceId) return
    try {
      await pinStore().move(pin.pinId, to, activeWorkspaceId)
    } catch (err: any) {
      toast.error(t("common.error"), err?.code === "ACCESS_DENIED" ? t("nav.zoneLocked") : (err?.message ?? String(err)))
    }
  }
  const onPatch = async (pin: NavbarPinData, patch: { label?: string; display?: "row" | "widget" }) => {
    if (!activeWorkspaceId) return
    try {
      await pinStore().update(pin.pinId, patch, activeWorkspaceId)
    } catch (err: any) {
      toast.error(t("common.error"), err?.message ?? String(err))
    }
  }

  const handleOpenAgent = (agentId: string, e?: any) => {
    setMobileMenuOpen(false)
    openWindow("agent", { agentId, workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined }, e && shouldOpenInNewTab(e))
  }
  const startChatWith = (agent: { agentId: string; name: string }, e?: any) => {
    setMobileMenuOpen(false)
    openWindow("chat", { agentId: agent.agentId, agentName: agent.name, workspaceId: activeWorkspaceId ?? undefined }, e ? shouldOpenInNewTab(e) : false)
  }
  const handleNewConversation = () => {
    setMobileMenuOpen(false)
    setShowNewConversationModal(true)
  }
  const handleSelectAgentForConversation = (agent: { agentId: string; name: string; fullName: string }, e?: any) => {
    openWindow("chat", { agentId: agent.agentId, agentName: agent.name || agent.fullName, workspaceId: activeWorkspaceId ?? undefined }, e && shouldOpenInNewTab(e))
  }
  const openHome = () => {
    setMobileMenuOpen(false)
    openWindow("home", { workspaceId: activeWorkspaceId ?? undefined }, false)
  }
  const openFromMenu = (type: string, props: Record<string, any> = {}) => {
    setMobileMenuOpen(false)
    openWindow(type, props, false)
  }

  // ── Workspace menu (same as Navbar) ─────────────────────────────────────
  const renderWorkspaceMenu = (collapsed: boolean) =>
    showWorkspaceDropdown ? (
      <>
        <Pressable style={styles.menuBackdrop} onPress={() => setShowWorkspaceDropdown(false)} />
        <View {...fx("menu")} style={[styles.menu, collapsed && styles.menuCollapsed, { top: dropdownTop }]} testID="workspace-menu">
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
            {sortedWorkspaces.map((ws) => {
              const isActive = activeWorkspaceId !== null ? ws.workspaceId === activeWorkspaceId : ws.type === "private"
              return (
                <Pressable
                  key={ws.workspaceId}
                  style={({ hovered, pressed }: any) => [styles.menuItem, (hovered || pressed) && styles.menuItemHover, isActive && styles.menuItemOn]}
                  onPress={() => {
                    switchWorkspace(ws.workspaceId)
                    setShowWorkspaceDropdown(false)
                  }}
                >
                  {ws.type === "private" ? (
                    <WorkspaceIcon icon="lock" color="amber" size={12} containerSize={22} />
                  ) : (
                    <WorkspaceIcon icon={ws.appearance?.icon} color={ws.appearance?.color} size={12} containerSize={22} />
                  )}
                  <Text style={[styles.menuItemText, isActive && { color: c.accent }]} numberOfLines={1}>
                    {ws.name}
                  </Text>
                  <Text style={styles.menuItemMeta}>{ws.role?.toUpperCase?.() ?? ""}</Text>
                  {isActive ? <Ph name="check" size={13} color={c.accent} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
          <View style={styles.menuHr} />
          <Pressable
            style={({ hovered, pressed }: any) => [styles.menuItem, (hovered || pressed) && styles.menuItemHover]}
            onPress={() => {
              setShowWorkspaceDropdown(false)
              openFromMenu("workspaces")
            }}
          >
            <Ph name="gear-six" size={14} color={c.text3} />
            <Text style={[styles.menuItemText, { color: c.text3 }]}>{t("nav.manageWorkspaces")}</Text>
          </Pressable>
        </View>
      </>
    ) : null

  const renderMenus = (collapsed: boolean) => {
    if (!menu || !activeWorkspaceId) return null
    if (menu.kind === "pin") {
      return (
        <PinMenu
          pin={menu.pin}
          anchor={menu.anchor}
          workspaceName={activeWs?.name ?? ""}
          canEditWorkspaceZone={!!canEditWorkspaceZone}
          onClose={() => setMenu(null)}
          onOpenNewTab={(pin) => openPin(pin, undefined, true)}
          onRename={(pin, label) => void onPatch(pin, { label })}
          onMove={(pin, to) => void onMove(pin, to)}
          onDisplay={(pin, display) => void onPatch(pin, { display })}
          onUnpin={(pin) => void onUnpin(pin)}
        />
      )
    }
    if (menu.kind === "picker") {
      return (
        <PinPicker
          zone={menu.zone}
          anchor={menu.anchor}
          workspaceId={activeWorkspaceId}
          workspaceName={activeWs?.name ?? ""}
          pins={pins}
          onClose={() => setMenu(null)}
          onPick={(input) => void anchor(menu.zone, input)}
        />
      )
    }
    return (
      <UserMenu
        bottom={collapsed ? 56 : 64}
        collapsed={collapsed}
        isAdmin={isAdmin}
        onClose={() => setMenu(null)}
        onOpen={openFromMenu}
        onWhatsNew={onWhatsNew}
        onLogout={onLogout}
      />
    )
  }

  const zoneProps = (zone: NavbarPinScope, collapsed: boolean) => ({
    zone,
    workspaceName: activeWs?.name ?? "",
    pins: zone === "workspace" ? zones.workspace : zones.personal,
    canEdit: zone === "workspace" ? !!canEditWorkspaceZone : true,
    collapsed,
    drop,
    isOn,
    onOpen: openPin,
    onMenu: (pin: NavbarPinData, a: MenuAnchor) => setMenu({ kind: "pin", pin, anchor: a }),
    onAdd: (a: MenuAnchor) => setMenu({ kind: "picker", zone, anchor: a }),
  })

  // ── Collapsed rail (`.rail`) ────────────────────────────────────────────
  const renderRail = () => (
    <View style={styles.rail} testID="navbar-v2-rail">
      <TouchableOpacity style={styles.railLogo} onPress={openHome} accessibilityLabel={t("nav.home")}>
        <TerosLogo size={26} animated={false} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.railNew}
        accessibilityLabel={t("nav.newChat")}
        onPress={(e) => (firstSuperAgent ? startChatWith(firstSuperAgent, e) : handleNewConversation())}
      >
        <Ph name="plus" size={18} color={c.inkPillText} />
      </TouchableOpacity>
      <PermissionIndicator collapsed />
      <RailBtn
        label={activeWs?.name ?? t("nav.workspace")}
        leading={
          activeWs?.type === "private" ? (
            <WorkspaceIcon icon="lock" color="amber" size={13} containerSize={26} />
          ) : (
            <WorkspaceIcon icon={activeWs?.appearance?.icon} color={activeWs?.appearance?.color} size={13} containerSize={26} />
          )
        }
        onPress={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
        testID="navbar-v2-workspace-rail"
      />
      {renderWorkspaceMenu(true)}
      <ScrollView style={styles.railStories} contentContainerStyle={styles.railStoriesIn} showsVerticalScrollIndicator={false}>
        <ZoneList {...zoneProps("workspace", true)} />
        <View style={{ width: 28, height: 1, backgroundColor: c.borderStrong, marginVertical: 4 }} />
        <ZoneList {...zoneProps("personal", true)} />
      </ScrollView>
      <View style={styles.railFoot}>
        <VoicePresenceBlock collapsed />
        <DesktopIndicator collapsed />
        <TouchableOpacity
          style={[styles.userAv, { width: 32, height: 32, borderRadius: 16 }]}
          onPress={() => setMenu({ kind: "user" })}
          accessibilityLabel={userName}
          testID="navbar-v2-user-rail"
        >
          <Text style={styles.userAvText}>{userInitials || "U"}</Text>
        </TouchableOpacity>
        {!isMobile && <IconBtn icon="sidebar-simple" plain onPress={() => setExpanded(true)} title={t("nav.expand")} />}
      </View>
      {renderMenus(true)}
    </View>
  )

  // ── Expanded sidebar (`.side`) ──────────────────────────────────────────
  const renderSidebarContent = (collapsed: boolean) => {
    if (collapsed) return renderRail()
    return (
      <>
        <View style={styles.brand}>
          <TouchableOpacity style={styles.brandHome} onPress={openHome} accessibilityLabel={t("nav.home")}>
            <TerosWordmark height={18} color={c.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {isMobile ? (
            <IconBtn icon="x" plain sm onPress={() => setMobileMenuOpen(false)} />
          ) : (
            <IconBtn icon="sidebar-simple" plain sm onPress={() => setExpanded(false)} title={t("nav.collapse")} />
          )}
        </View>

        <View style={styles.agentRow}>
          <TouchableOpacity
            style={styles.agentSwitch}
            activeOpacity={0.85}
            onPress={(e) => (firstSuperAgent ? handleOpenAgent(firstSuperAgent.agentId, e) : handleNewConversation())}
          >
            {firstSuperAgent ? (
              <Avatar name={firstSuperAgent.name} imageUrl={firstSuperAgent.avatarUrl} size={36} isAgent />
            ) : (
              <View style={styles.agentSwitchPlaceholder}>
                <Ph name="sparkle" size={16} color={c.accent} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.agentSwitchName} numberOfLines={1}>
                {superFirstName ?? t("nav.agents")}
              </Text>
            </View>
            {extraSuperAgents > 0 ? <Text style={styles.agentSwitchExtra}>+{extraSuperAgents}</Text> : null}
            <Ph name="caret-up-down" size={14} color={c.text3} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.newChat, { backgroundColor: isDark ? semanticColors.purple300 : semanticColors.main400 }]}
            accessibilityLabel={t("nav.newChat")}
            onPress={(e) => (firstSuperAgent ? startChatWith(firstSuperAgent, e) : handleNewConversation())}
          >
            <Halo color={isDark ? semanticColors.purple300 : semanticColors.main400} size="md" />
            <View style={{ zIndex: 1 }}>
              <Ph name="plus" size={16} color={isDark ? "#FFFFFF" : "#201C27"} />
            </View>
          </TouchableOpacity>
        </View>

        <PermissionIndicator />

        <View ref={workspaceSelectorRef} style={styles.wsRow}>
          <SelectField
            style={{ flex: 1, backgroundColor: c.field, borderColor: c.text3 }}
            icon={
              activeWs?.type === "private" ? (
                <WorkspaceIcon icon="lock" color="amber" size={13} containerSize={20} />
              ) : (
                <WorkspaceIcon icon={activeWs?.appearance?.icon} color={activeWs?.appearance?.color} size={13} containerSize={20} />
              )
            }
            label={activeWs?.name ?? t("nav.workspace")}
            meta={activeWs?.role ? activeWs.role.toUpperCase() : undefined}
            onPress={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
          />
          {activeWorkspaceId ? (
            <IconBtn icon="gear-six" plain onPress={() => openFromMenu("workspace", { workspaceId: activeWorkspaceId })} title={t("nav.workspaceSettings")} />
          ) : null}
        </View>
        {renderWorkspaceMenu(false)}

        {/* The two zones (NAV-REQ-1) */}
        <View style={styles.sidebarContentWrapper}>
          {scrollState.canScrollUp && (
            <LinearGradient colors={[c.bgFrame, "transparent"]} style={styles.scrollGradientTop} pointerEvents="none" />
          )}
          <ScrollView
            ref={scrollViewRef}
            style={styles.sidebarContent}
            contentContainerStyle={styles.sidebarContentIn}
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            onContentSizeChange={handleContentSizeChange}
            scrollEventThrottle={16}
          >
            <ZoneList {...zoneProps("workspace", false)} />
            <ZoneList {...zoneProps("personal", false)} />
          </ScrollView>
          {scrollState.canScrollDown && (
            <LinearGradient colors={["transparent", c.bgFrame]} style={styles.scrollGradientBottom} pointerEvents="none" />
          )}
        </View>

        <View style={styles.layoutSeg}>
          <DesktopIndicator />
        </View>
        <VoicePresenceBlock />

        {/* User row → the person's menu (NAV-REQ-13) */}
        <View style={styles.userRow}>
          <TouchableOpacity style={styles.userMain} onPress={() => setMenu({ kind: "user" })} activeOpacity={0.8} testID="navbar-v2-user">
            <View style={styles.userAv}>
              <Text style={styles.userAvText}>{userInitials || "U"}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.userName} numberOfLines={1}>
                {userName}
              </Text>
              <Text style={styles.userMeta} numberOfLines={1}>
                {[activeWs?.role ?? userRole, activeWs?.name].filter(Boolean).join(" · ").toUpperCase()}
              </Text>
            </View>
          </TouchableOpacity>
          <ThemeToggleButton />
        </View>
        {renderMenus(false)}
      </>
    )
  }

  return (
    <View style={styles.container} {...fx("shell")}>
      {!isMobile && isExpanded && Platform.OS === "web" ? (
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: sidebarWidth }}>
          <FrameMelt side="side" frame={c.bgFrame} sheet={c.bgSheet} />
        </View>
      ) : null}
      {!isMobile && (
        <View
          ref={setDropNode as any}
          testID="navbar-v2"
          style={[styles.sidebar, { width: sidebarWidth, paddingTop: insets.top, paddingBottom: insets.bottom }]}
        >
          {renderSidebarContent(!isExpanded)}
          {/* Phase 2 of the gesture: the link chip follows the cursor (NAV-REQ-15); a row drag has none (NAV-REQ-19) */}
          {drop.active && drop.kind === "window" && Platform.OS === "web" ? (
            <View
              pointerEvents="none"
              style={{
                position: "fixed" as any,
                left: drop.x + 14,
                top: drop.y + 12,
                zIndex: 20000,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingVertical: 5,
                paddingHorizontal: 10,
                borderRadius: 100,
                backgroundColor: c.inkPill,
              }}
            >
              <Ph name="link" size={12} color={c.inkPillText} />
              <Text style={{ color: c.inkPillText, fontSize: 12 }}>
                {drop.zone === "workspace"
                  ? t("nav.visibleToAll", { name: activeWs?.name ?? "" })
                  : drop.zone === "personal"
                    ? t("nav.onlyYou")
                    : t("nav.pinHere")}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      <View style={styles.mainContent}>
        <View style={[styles.pageContent, !isMobile && { paddingTop: insets.top }]}>{children}</View>
      </View>

      {isMobile && (
        <Modal visible={isMobileMenuOpen} transparent animationType="fade" onRequestClose={() => setMobileMenuOpen(false)}>
          <View style={styles.modalOverlay}>
            <TouchableOpacity style={styles.modalBackdrop} onPress={() => setMobileMenuOpen(false)} activeOpacity={1} />
            <View style={[styles.mobileSidebar, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
              {renderSidebarContent(false)}
            </View>
          </View>
        </Modal>
      )}

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgentForConversation}
      />
    </View>
  )
}
