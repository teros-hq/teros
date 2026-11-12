/**
 * PinMenu — the "···" menu of an anchored window, and PinPicker — the "+" of a
 * zone (anchor an open window, or a workspace, without dragging).
 * Same floating panel as the workspace menu of the navbar.
 *
 * @spec NAV-REQ-10, NAV-REQ-11
 */
import type React from "react"
import { useMemo, useState } from "react"
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useTilingStore } from "../../store/tilingStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"
import { fx } from "../../styles/fx"
import { Field, Ph } from "../ui/ds"
import { WorkspaceIcon } from "../WorkspaceIcon"
import { windowRegistry } from "../../services/windowRegistry"
import type { NavbarPinData, NavbarPinScope, NavbarPinWindow } from "../../services/NavbarApi"
import { findPinForWindow, hasWidget, isPortable, pinIcon, pinInputFromWindow, pinLabel, WORKSPACE_LINK } from "./pinModel"
import { EXPANDED_WIDTH, useNavbarStyles } from "./primitives"

export interface MenuAnchor {
  x: number
  y: number
}

function Panel({
  anchor,
  onClose,
  width = EXPANDED_WIDTH - 24,
  children,
}: {
  anchor: MenuAnchor
  onClose: () => void
  width?: number
  children: React.ReactNode
}) {
  const styles = useNavbarStyles()
  const left = Math.max(8, Math.min(anchor.x, (Platform.OS === "web" ? window.innerWidth : 9999) - width - 8))
  const top = Math.max(8, Math.min(anchor.y, (Platform.OS === "web" ? window.innerHeight : 9999) - 360))
  // A transparent Modal so the panel paints above the sheet: every RN-web View
  // is its own stacking context (z-index: 0), so a fixed panel rendered inside
  // the sidebar would sit under the main content wherever they overlap.
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={[styles.menuBackdrop, { position: "absolute" }]} onPress={onClose} testID="navbar-menu-backdrop" />
      <View {...fx("menu")} style={[styles.menu, { position: "absolute", top, left, width }]} testID="navbar-menu">
        {children}
      </View>
    </Modal>
  )
}

function Item({
  icon,
  label,
  meta,
  onPress,
  danger,
  leading,
  testID,
}: {
  icon?: string
  label: string
  meta?: string
  onPress: () => void
  danger?: boolean
  leading?: React.ReactNode
  testID?: string
}) {
  const c = useColors()
  const styles = useNavbarStyles()
  return (
    <Pressable
      testID={testID}
      style={({ hovered, pressed }: any) => [styles.menuItem, (hovered || pressed) && styles.menuItemHover]}
      onPress={onPress}
    >
      {leading ?? (icon ? <Ph name={icon} size={14} color={danger ? semanticColors.red : c.text3} /> : null)}
      <Text style={[styles.menuItemText, danger && { color: semanticColors.red }]} numberOfLines={1}>
        {label}
      </Text>
      {meta ? <Text style={styles.menuItemMeta}>{meta}</Text> : null}
    </Pressable>
  )
}

export interface PinMenuProps {
  pin: NavbarPinData
  anchor: MenuAnchor
  workspaceName: string
  canEditWorkspaceZone: boolean
  onClose: () => void
  onOpenNewTab: (pin: NavbarPinData) => void
  onRename: (pin: NavbarPinData, label: string) => void
  onMove: (pin: NavbarPinData, to: { scope?: NavbarPinScope; global?: boolean }) => void
  onDisplay: (pin: NavbarPinData, display: "row" | "widget") => void
  onUnpin: (pin: NavbarPinData) => void
}

/** @spec NAV-REQ-10 */
export function PinMenu(p: PinMenuProps) {
  const { t } = useTranslation()
  const c = useColors()
  const styles = useNavbarStyles()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(pinLabel(p.pin, t))
  const isWorkspaceLink = p.pin.window.type === WORKSPACE_LINK
  const personal = p.pin.scope === "personal"

  if (renaming) {
    return (
      <Panel anchor={p.anchor} onClose={p.onClose}>
        <View style={{ padding: 6, gap: 8 }}>
          <Field
            autoFocus
            value={name}
            onChangeText={setName}
            placeholder={t("nav.rename")}
            onSubmitEditing={() => {
              if (name.trim()) p.onRename(p.pin, name.trim())
              p.onClose()
            }}
            testID="pin-rename-input"
          />
        </View>
      </Panel>
    )
  }

  return (
    <Panel anchor={p.anchor} onClose={p.onClose}>
      {!isWorkspaceLink ? (
        <Item icon="arrow-square-out" label={t("nav.openInNewTab")} onPress={() => { p.onOpenNewTab(p.pin); p.onClose() }} />
      ) : null}
      <Item icon="pencil-simple" label={t("nav.rename")} onPress={() => setRenaming(true)} testID="pin-menu-rename" />
      {!isWorkspaceLink ? (
        personal ? (
          p.canEditWorkspaceZone ? (
            <Item icon="arrow-right" label={t("nav.moveToWorkspace", { name: p.workspaceName })} onPress={() => { p.onMove(p.pin, { scope: "workspace" }); p.onClose() }} testID="pin-menu-move" />
          ) : null
        ) : (
          <Item icon="arrow-right" label={t("nav.moveToPersonal")} onPress={() => { p.onMove(p.pin, { scope: "personal" }); p.onClose() }} testID="pin-menu-move" />
        )
      ) : null}
      {personal && !isWorkspaceLink ? (
        p.pin.global ? (
          <Item icon="map-pin" label={t("nav.makeLocal", { name: p.workspaceName })} onPress={() => { p.onMove(p.pin, { global: false }); p.onClose() }} testID="pin-menu-global" />
        ) : isPortable(p.pin) ? (
          <Item icon="globe" label={t("nav.makeGlobal")} onPress={() => { p.onMove(p.pin, { global: true }); p.onClose() }} testID="pin-menu-global" />
        ) : null
      ) : null}
      {hasWidget(p.pin) ? (
        <Item
          icon="squares-four"
          label={p.pin.display === "widget" ? t("nav.showAsRow") : t("nav.showAsWidget")}
          onPress={() => { p.onDisplay(p.pin, p.pin.display === "widget" ? "row" : "widget"); p.onClose() }}
          testID="pin-menu-display"
        />
      ) : null}
      <View style={styles.menuHr} />
      <Item icon="trash" label={t("nav.unpin")} danger onPress={() => { p.onUnpin(p.pin); p.onClose() }} testID="pin-menu-unpin" />
      {p.pin.createdBy.kind === "agent" ? (
        <Text style={[styles.menuItemMeta, { paddingHorizontal: 10, paddingVertical: 6, color: c.text3 }]}>{t("nav.pinnedByAgent")}</Text>
      ) : null}
    </Panel>
  )
}

export interface PinPickerProps {
  zone: NavbarPinScope
  anchor: MenuAnchor
  workspaceId: string
  workspaceName: string
  pins: NavbarPinData[]
  onClose: () => void
  onPick: (input: { window: NavbarPinWindow; label: string; icon: string }) => void
}

/** @spec NAV-REQ-11 — anchor an open window (or a workspace, in personal) without dragging. */
export function PinPicker(p: PinPickerProps) {
  const { t } = useTranslation()
  const c = useColors()
  const styles = useNavbarStyles()
  const windows = useTilingStore((s) => s.windows)
  const workspaces = useNavbarStore((s) => s.workspaces)

  const openWindows = useMemo(
    () =>
      Object.values(windows)
        .filter((w) => windowRegistry.has(w.type) && !findPinForWindow(p.pins, w))
        .map((w) => ({ id: w.id, ...pinInputFromWindow(w, t) })),
    [windows, p.pins, t],
  )
  const otherWorkspaces = useMemo(
    () =>
      p.zone === "personal"
        ? workspaces.filter(
            (ws) =>
              ws.workspaceId !== p.workspaceId &&
              !p.pins.some((pin) => pin.window.type === WORKSPACE_LINK && pin.window.props?.workspaceId === ws.workspaceId),
          )
        : [],
    [workspaces, p.zone, p.workspaceId, p.pins],
  )

  return (
    <Panel anchor={p.anchor} onClose={p.onClose}>
      <Text style={[styles.menuItemMeta, { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 2 }]}>
        {(p.zone === "workspace" ? t("nav.pinInWorkspace", { name: p.workspaceName }) : t("nav.pinInPersonal")).toUpperCase()}
      </Text>
      <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
        <Text style={[styles.menuItemMeta, { paddingHorizontal: 10, paddingVertical: 4 }]}>{t("nav.openWindows").toUpperCase()}</Text>
        {openWindows.length === 0 ? (
          <Text style={[styles.menuItemText, { color: c.text3, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12.5 }]}>
            {t("nav.dragHere")}
          </Text>
        ) : null}
        {openWindows.map((w) => (
          <Item key={w.id} icon={w.icon} label={w.label} onPress={() => { p.onPick(w); p.onClose() }} testID={`pin-picker-${w.window.type}`} />
        ))}
        {otherWorkspaces.length ? (
          <>
            <View style={styles.menuHr} />
            <Text style={[styles.menuItemMeta, { paddingHorizontal: 10, paddingVertical: 4 }]}>{t("nav.pinWorkspace").toUpperCase()}</Text>
            {otherWorkspaces.map((ws) => (
              <Item
                key={ws.workspaceId}
                label={ws.name}
                meta={ws.role?.toUpperCase?.()}
                leading={
                  ws.type === "private" ? (
                    <WorkspaceIcon icon="lock" color="amber" size={12} containerSize={22} />
                  ) : (
                    <WorkspaceIcon icon={ws.appearance?.icon} color={ws.appearance?.color} size={12} containerSize={22} />
                  )
                }
                onPress={() => {
                  p.onPick({
                    window: { type: WORKSPACE_LINK, props: { workspaceId: ws.workspaceId } },
                    label: ws.name,
                    icon: pinIcon({ window: { type: WORKSPACE_LINK, props: {} } }),
                  })
                  p.onClose()
                }}
                testID={`pin-picker-ws-${ws.workspaceId}`}
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </Panel>
  )
}
