/**
 * ZoneList — one zone of the rail (workspace or personal): the SecH header with
 * its action, the anchored windows as rows or widgets, the drop legend and the
 * insertion line while a tab is dragged over it, and the collapsed icon column.
 *
 * @spec NAV-REQ-1, NAV-REQ-9, NAV-REQ-10, NAV-REQ-11, NAV-REQ-14, NAV-REQ-15, NAV-REQ-19, NAV-REQ-20
 */
import type React from "react"
import { Suspense, useState } from "react"
import { Platform, Pressable, Text, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../mca/primitives/useColors"
import { FONT_SANS } from "../mca/primitives/fonts"
import { IconBtn, Ph, SecH } from "../ui/ds"
import { WorkspaceIcon } from "../WorkspaceIcon"
import { useNavbarStore } from "../../store/navbarStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { NavbarPinData, NavbarPinScope } from "../../services/NavbarApi"
import { hasWidget, openProps, PIN_DRAG_MIME, pinIcon, pinLabel, widgetOf, WORKSPACE_LINK } from "./pinModel"
import { RailBtn, SideItem, useNavbarStyles } from "./primitives"
import type { RailDropState } from "./useRailDrop"
import type { MenuAnchor } from "./PinMenu"

export interface ZoneListProps {
  zone: NavbarPinScope
  workspaceName: string
  pins: NavbarPinData[]
  /** Owner/admin for the workspace zone, always true for personal. */
  canEdit: boolean
  collapsed?: boolean
  drop?: RailDropState
  isOn: (pin: NavbarPinData) => boolean
  onOpen: (pin: NavbarPinData, e?: any) => void
  onMenu: (pin: NavbarPinData, anchor: MenuAnchor) => void
  onAdd: (anchor: MenuAnchor) => void
  onReorder?: (pinIds: string[]) => void
}

function anchorOf(e: any): MenuAnchor {
  const ne = e?.nativeEvent ?? e ?? {}
  return { x: Number(ne.pageX ?? ne.clientX ?? 24), y: Number(ne.pageY ?? ne.clientY ?? 120) + 8 }
}

/**
 * The "···" of a row. Not an IconBtn: the row is already a <button> on web and
 * a nested <button> is invalid HTML (the inner click is swallowed).
 */
function RowAction({ onPress, testID, title }: { onPress: (e: any) => void; testID?: string; title?: string }) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  const base = { width: 22, height: 22, borderRadius: 7, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: hover ? c.wash2 : "transparent" }
  if (Platform.OS === "web") {
    // A plain element with onClick: the row is a Pressable whose press
    // responder swallows a nested Pressable's real mouse click.
    return (
      <View
        testID={testID}
        {...({
          // No role="button": the row already is one and nested <button>s are invalid HTML.
          tabIndex: 0,
          "aria-label": title,
          title,
          onClick: (e: any) => {
            e?.stopPropagation?.()
            onPress(e)
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: { cursor: "pointer" },
        } as any)}
        style={base}
      >
        <Ph name="dots-three" size={14} color={c.text3} />
      </View>
    )
  }
  return (
    <Pressable testID={testID} onPress={onPress} style={base}>
      <Ph name="dots-three" size={14} color={c.text3} />
    </Pressable>
  )
}

/** The leading glyph of a pin: the workspace tile for a workspace link, the window's icon otherwise. */
function PinLeading({ pin, size }: { pin: NavbarPinData; size: number }) {
  const workspaces = useNavbarStore((s) => s.workspaces)
  if (pin.window.type === WORKSPACE_LINK) {
    const ws = workspaces.find((w) => w.workspaceId === pin.window.props?.workspaceId)
    return ws?.type === "private" ? (
      <WorkspaceIcon icon="lock" color="amber" size={size - 8} containerSize={size} />
    ) : (
      <WorkspaceIcon icon={ws?.appearance?.icon} color={ws?.appearance?.color} size={size - 8} containerSize={size} />
    )
  }
  return null
}

/** @spec NAV-REQ-10, NAV-REQ-20 — a pin shown as a widget: the card's header, then the window's own widget. */
function WidgetCard({ pin, label, on, dim, onPress, onMenu, domRef }: { pin: NavbarPinData; label: string; on: boolean; dim: boolean; onPress: (e?: any) => void; onMenu?: (e: any) => void; domRef?: (el: unknown) => void }) {
  const c = useColors()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const Widget = widgetOf(pin.window.type)
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      ref={domRef as any}
      testID={`pin-${pin.pinId}`}
      onPress={onPress}
      accessibilityRole="button"
      {...(Platform.OS === "web" ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) } : {})}
      style={({ hovered, pressed }: any) => [
        {
          marginHorizontal: 4,
          marginVertical: 3,
          borderRadius: 12,
          backgroundColor: on ? c.navActive : c.bgStep,
          padding: 10,
          gap: 8,
          borderWidth: 1,
          borderColor: on ? c.borderAccent : c.borderStrong,
        },
        (hovered || pressed) && !on && { backgroundColor: c.bgCard },
        dim && { opacity: 0.5 },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ph name={pinIcon(pin)} size={14} color={c.accent} />
        <Text style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: c.text, flex: 1 }} numberOfLines={1}>
          {label}
        </Text>
        {onMenu ? (
          // Like the rows: always mounted (no height change), visible on hover.
          <View style={{ opacity: hover || Platform.OS !== "web" ? 1 : 0 }}>
            <RowAction onPress={onMenu} testID={`pin-menu-${pin.pinId}`} />
          </View>
        ) : null}
      </View>
      {Widget ? (
        <Suspense fallback={null}>
          <Widget props={openProps(pin)} workspaceId={activeWorkspaceId} on={on} />
        </Suspense>
      ) : null}
    </Pressable>
  )
}

/**
 * Makes a row's DOM node a drag source (NAV-REQ-19) — only in editable zones.
 * RN-web's Pressable forwards neither `draggable` nor the drag handlers, so
 * they are set on the node itself. The data type is the rail's own, never
 * `text/plain`, so the tiling ignores a row drag.
 */
function rowDragRef(pinId: string, enabled: boolean, setDragging: (id: string | null) => void) {
  if (Platform.OS !== "web") return undefined
  return (node: unknown) => {
    const el = node as HTMLElement | null
    if (!el) return
    el.draggable = enabled
    el.ondragstart = enabled
      ? (e: DragEvent) => {
          e.stopPropagation()
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData(PIN_DRAG_MIME, pinId)
          }
          setDragging(pinId)
        }
      : null
    el.ondragend = enabled ? () => setDragging(null) : null
  }
}

/** @spec NAV-REQ-1, NAV-REQ-19 */
export function ZoneList(p: ZoneListProps) {
  const { t } = useTranslation()
  const c = useColors()
  const styles = useNavbarStyles()
  const [dragging, setDragging] = useState<string | null>(null)
  const dropHere = !!p.drop?.active && p.drop.zone === p.zone
  const dropActive = !!p.drop?.active
  // The legend answers "who will see this?" — a question a tab drag raises
  // and a row drag (reorder/move, NAV-REQ-19) does not.
  const showLegend = dropHere && p.drop?.kind === "window"
  const title = p.zone === "workspace" ? `${t("nav.zoneWorkspace")} · ${p.workspaceName}` : t("nav.zonePersonal")
  const legend = p.zone === "workspace" ? t("nav.visibleToAllShort") : t("nav.onlyYou")

  const insertLine = (
    <View style={{ height: 2, borderRadius: 1, backgroundColor: c.accent, marginHorizontal: 8, marginVertical: 1 }} />
  )

  if (p.collapsed) {
    return (
      <View
        {...(Platform.OS === "web" ? ({ dataSet: { zone: p.zone } } as any) : {})}
        style={[
          { alignItems: "center", gap: 2, borderRadius: 12, paddingVertical: 2, alignSelf: "stretch" },
          dropActive && { borderWidth: 1, borderStyle: "dashed", borderColor: c.borderStrong, margin: -1 },
          dropHere && { borderColor: c.accent, backgroundColor: c.navActive },
        ]}
        testID={`zone-${p.zone}-collapsed`}
      >
        {p.pins.map((pin) => (
          <View
            key={pin.pinId}
            {...(Platform.OS === "web" ? ({ dataSet: { pin: pin.pinId } } as any) : {})}
            style={dragging === pin.pinId ? { opacity: 0.35 } : undefined}
          >
            {dropHere && p.drop?.beforeId === pin.pinId ? insertLine : null}
            <RailBtn
              testID={`pin-${pin.pinId}`}
              domRef={rowDragRef(pin.pinId, p.canEdit, setDragging)}
              icon={pinIcon(pin)}
              leading={pin.window.type === WORKSPACE_LINK ? <PinLeading pin={pin} size={26} /> : undefined}
              label={pinLabel(pin, t)}
              on={p.isOn(pin)}
              dim={!pin.enabled}
              onPress={(e) => p.onOpen(pin, e)}
              onLongPress={(e) => p.onMenu(pin, anchorOf(e))}
            />
          </View>
        ))}
        {dropHere && !p.drop?.beforeId ? insertLine : null}
      </View>
    )
  }

  return (
    <View
      {...(Platform.OS === "web" ? ({ dataSet: { zone: p.zone } } as any) : {})}
      style={[
        { borderRadius: 12 },
        dropActive && { borderWidth: 1, borderStyle: "dashed", borderColor: c.borderStrong, margin: -1 },
        dropHere && { borderColor: c.accent, backgroundColor: c.navActive },
      ]}
      testID={`zone-${p.zone}`}
    >
      <SecH label={showLegend ? legend : title}>
        {showLegend ? null : p.canEdit ? (
          <IconBtn icon="plus" plain sm onPress={(e: any) => p.onAdd(anchorOf(e))} title={t("nav.pinHere")} testID={`zone-${p.zone}-add`} />
        ) : (
          <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center" }} {...(Platform.OS === "web" ? ({ title: t("nav.zoneLocked") } as any) : {})}>
            <Ph name="users" size={13} color={c.text3} />
          </View>
        )}
      </SecH>
      {p.pins.length === 0 ? (
        <Text style={[styles.itemText, { color: c.text3, fontStyle: "italic", paddingHorizontal: 12, paddingVertical: 6 }]}>
          {p.zone === "personal" ? t("nav.dragHere") : t("nav.nothingPinned")}
        </Text>
      ) : null}
      {p.pins.map((pin) => {
        const label = pinLabel(pin, t)
        const on = p.isOn(pin)
        const dim = !pin.enabled
        const menuBtn = p.canEdit ? (
          <RowAction onPress={(e: any) => p.onMenu(pin, anchorOf(e))} testID={`pin-menu-${pin.pinId}`} />
        ) : undefined
        return (
          <View
            key={pin.pinId}
            {...(Platform.OS === "web" ? ({ dataSet: { pin: pin.pinId } } as any) : {})}
            style={dragging === pin.pinId ? { opacity: 0.35 } : undefined}
          >
            {dropHere && p.drop?.beforeId === pin.pinId ? insertLine : null}
            {pin.display === "widget" && hasWidget(pin) ? (
              <WidgetCard pin={pin} label={label} on={on} dim={dim} onPress={(e) => p.onOpen(pin, e)} onMenu={p.canEdit ? (e) => p.onMenu(pin, anchorOf(e)) : undefined} domRef={rowDragRef(pin.pinId, p.canEdit, setDragging)} />
            ) : (
              <View style={dim ? { opacity: 0.5 } : undefined} {...(Platform.OS === "web" && dim ? ({ title: t("nav.disabledByAdmin", { name: p.workspaceName }) } as any) : {})}>
                <SideItem
                  testID={`pin-${pin.pinId}`}
                  domRef={rowDragRef(pin.pinId, p.canEdit, setDragging)}
                  on={on}
                  icon={pin.window.type === WORKSPACE_LINK ? undefined : pinIcon(pin)}
                  leading={pin.window.type === WORKSPACE_LINK ? <PinLeading pin={pin} size={20} /> : undefined}
                  label={label}
                  action={menuBtn}
                  trailing={
                    dim ? (
                      <Ph name="lock" size={12} color={c.text3} />
                    ) : pin.createdBy.kind === "agent" ? (
                      <Ph name="robot" size={12} color={c.accent} />
                    ) : undefined
                  }
                  onPress={(e) => p.onOpen(pin, e)}
                />
              </View>
            )}
          </View>
        )
      })}
      {dropHere && !p.drop?.beforeId ? insertLine : null}
    </View>
  )
}
