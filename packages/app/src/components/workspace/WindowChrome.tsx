import type React from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Platform, TextInput, type TextStyle, View } from "react-native"
import { Popover, Separator, Text, XStack, YStack } from "tamagui"
import { type TabWindow, useTabState } from "../../hooks/useTabState"
import {
  useWindowChromeOf,
  type WindowFace,
  type WindowMenuEntry,
  type WindowTabIcon,
  type WindowTabMark,
  type WindowTitleEdit,
} from "../../store/windowChromeStore"
import { Avatar } from "../Avatar"
import { useColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds"
import { TAB_MARKS_YIELD } from "./tabStrip"

const WEB = Platform.OS === "web"
const CHROME_IN = "teros-chrome-in 180ms ease-out"
const CHROME_PULSE = "teros-chrome-pulse 1.8s ease-in-out infinite"
let installed = false

function installChromeMotion(): void {
  if (installed || typeof document === "undefined") return
  const style = document.createElement("style")
  style.dataset.terosChromeMotion = "1"
  style.textContent = [
    "@keyframes teros-chrome-in{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}",
    "@keyframes teros-chrome-pulse{0%,100%{opacity:1;transform:none}50%{opacity:.72;transform:scale(.92)}}",
    "@media (prefers-reduced-motion: reduce){[data-chrome-motion]{animation:none !important}}",
  ].join("")
  document.head.appendChild(style)
  installed = true
}

function hint(text: string | undefined) {
  return (el: unknown) => {
    const node = el as { setAttribute?: (name: string, value: string) => void } | null
    if (text) node?.setAttribute?.("title", text)
  }
}

function Face({ face, size }: { face: WindowFace; size: number }) {
  return <Avatar name={face.name} imageUrl={face.imageUrl} size={size} />
}

export function ChromeIcon({
  icon,
  size,
  glyph,
}: {
  icon: WindowTabIcon
  size: number
  glyph: string
}) {
  const c = useColors()
  useEffect(installChromeMotion, [])
  const key = icon.face ? `face-${icon.face.id}` : `icon-${icon.icon ?? ""}`
  const motion = icon.pulse ? `${CHROME_IN}, ${CHROME_PULSE}` : CHROME_IN
  return (
    <View
      key={key}
      testID={icon.face ? "window-icon-face" : `window-icon-${icon.icon ?? "none"}`}
      accessibilityLabel={icon.tooltip}
      ref={hint(icon.tooltip)}
      {...({ dataSet: { chromeMotion: "1" } } as object)}
      style={[
        { alignItems: "center", justifyContent: "center" },
        WEB ? ({ animation: motion } as object) : null,
        icon.face
          ? {
              borderRadius: size,
              borderWidth: 1,
              borderColor: c.accent,
            }
          : null,
      ]}
    >
      {icon.face ? (
        <Face face={icon.face} size={size} />
      ) : icon.icon ? (
        <Ph
          name={icon.icon}
          size={size}
          weight={icon.tone === "accent" ? "fill" : "regular"}
          color={icon.tone === "accent" ? c.accent : glyph}
        />
      ) : null}
    </View>
  )
}

const MAX_FACES = 2

export function TabMarks({
  marks,
  compact = false,
  yields = false,
  color,
}: {
  marks: WindowTabMark[] | undefined
  compact?: boolean
  yields?: boolean
  color: string
}) {
  const c = useColors()
  if (!marks || marks.length === 0) return null
  return (
    <View
      testID="window-marks"
      style={[
        { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
        yields ? { flexShrink: TAB_MARKS_YIELD, minWidth: 0, overflow: "hidden" } : null,
      ]}
    >
      {marks.map((mark) => {
        const faces = mark.faces ?? []
        const count = mark.count ?? faces.length
        const pile = faces.length > 0 && !compact
        return (
          <View
            key={mark.id}
            testID={`window-mark-${mark.id}`}
            accessibilityLabel={mark.label}
            ref={hint(mark.label)}
            style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
          >
            {pile ? (
              <>
                {faces.slice(0, MAX_FACES).map((face, index) => (
                  <View
                    key={face.id}
                    style={{
                      marginLeft: index === 0 ? 0 : -6,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: c.bgSheet,
                    }}
                  >
                    <Face face={face} size={16} />
                  </View>
                ))}
                {faces.length > MAX_FACES ? (
                  <Text fontSize={10} fontFamily="Saans" color={color}>
                    +{faces.length - MAX_FACES}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Ph name={mark.icon} size={12} color={color} />
                {count > 0 ? (
                  <Text fontSize={10} fontFamily="Saans" color={color}>
                    {count}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        )
      })}
    </View>
  )
}

export function WindowRing({ radius, line = false }: { radius?: string; line?: boolean }) {
  const c = useColors()
  if (line)
    return (
      <View
        testID="window-ring"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          zIndex: 40,
          backgroundColor: c.accent,
          pointerEvents: "none",
        }}
      />
    )
  return (
    <View
      testID="window-ring"
      style={[
        {
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          zIndex: 40,
          borderWidth: 1,
          borderColor: c.accent,
          pointerEvents: "none",
        },
        WEB
          ? ({
              boxShadow: `inset 0 0 0 1px ${c.navActive}, inset 0 0 18px ${c.navActive}`,
              borderRadius: radius,
            } as object)
          : null,
      ]}
    />
  )
}

function EntryRow({ entry, onDone }: { entry: WindowMenuEntry; onDone: () => void }) {
  const c = useColors()
  const fg = entry.danger ? c.tint.r.tx : c.text
  const press = () => {
    onDone()
    entry.onPress()
  }
  return (
    <XStack
      testID={`window-menu-${entry.id}`}
      paddingHorizontal={10}
      paddingVertical={entry.detail ? 6 : 8}
      gap={10}
      alignItems="center"
      borderRadius={10}
      opacity={entry.disabled ? 0.5 : 1}
      cursor={entry.disabled ? "default" : "pointer"}
      hoverStyle={entry.disabled ? {} : { backgroundColor: c.wash }}
      onPress={entry.disabled ? undefined : press}
      accessibilityRole="menuitem"
      accessibilityLabel={entry.label}
      aria-disabled={entry.disabled ? true : undefined}
      aria-checked={entry.checked}
    >
      {entry.icon ? (
        <Ph
          name={entry.icon}
          size={14}
          weight={entry.checked ? "fill" : "regular"}
          color={entry.danger ? c.tint.r.tx : entry.checked ? c.accent : c.text2}
        />
      ) : (
        <View style={{ width: 14 }} />
      )}
      <YStack flex={1} minWidth={0}>
        <Text fontSize={13} color={fg} fontFamily="Saans" numberOfLines={1}>
          {entry.label}
        </Text>
        {entry.detail ? (
          <Text fontSize={11} color={c.text3} fontFamily="Saans">
            {entry.detail}
          </Text>
        ) : null}
      </YStack>
      {entry.trailing ? (
        <Text fontSize={12} color={entry.checked ? c.accent : c.text3} fontFamily="Saans">
          {entry.trailing}
        </Text>
      ) : null}
      {entry.shortcut ? (
        <Text fontSize={11} color={c.text3} fontFamily="Saans" marginLeft={6}>
          {entry.shortcut}
        </Text>
      ) : null}
    </XStack>
  )
}

export function WindowMenuSection({
  window,
  onDone,
  last = false,
}: {
  window: TabWindow
  onDone: () => void
  last?: boolean
}) {
  const c = useColors()
  const { title } = useTabState(window, true)
  const menu = useWindowChromeOf(window.id).menu
  if (!menu || menu.entries.length === 0) return null
  return (
    <YStack testID={`window-menu-section-${window.id}`}>
      <XStack paddingHorizontal={10} paddingTop={6} paddingBottom={4} gap={8} alignItems="center">
        <Text
          flex={1}
          fontSize={11}
          fontFamily="Saans"
          fontWeight="600"
          color={c.text2}
          numberOfLines={1}
        >
          {title}
        </Text>
        {menu.caption ? (
          <Text fontSize={11} fontFamily="Saans" color={c.text3} numberOfLines={1}>
            {menu.caption}
          </Text>
        ) : null}
      </XStack>
      {menu.entries.map((entry) => (
        <YStack key={entry.id}>
          {entry.separated ? (
            <Separator marginVertical={6} marginHorizontal={4} backgroundColor={c.border} />
          ) : null}
          <EntryRow entry={entry} onDone={onDone} />
        </YStack>
      ))}
      {last ? null : (
        <Separator marginVertical={6} marginHorizontal={4} backgroundColor={c.border} />
      )}
    </YStack>
  )
}

export function WindowMenuButton({ window, size = 28 }: { window: TabWindow; size?: number }) {
  const { t } = useTranslation()
  const c = useColors()
  const [open, setOpen] = useState(false)
  const menu = useWindowChromeOf(window.id).menu
  if (!menu || menu.entries.length === 0) return null
  const label = t("windows.windowMenu", { defaultValue: "Window menu" })
  return (
    <Popover open={open} onOpenChange={setOpen} placement="bottom-end">
      <Popover.Trigger asChild>
        <XStack
          testID={`window-menu-button-${window.id}`}
          width={size}
          height={size}
          justifyContent="center"
          alignItems="center"
          borderRadius={100}
          cursor="pointer"
          hoverStyle={{ backgroundColor: c.wash }}
          accessibilityRole="button"
          accessibilityLabel={label}
          {...(WEB ? ({ title: label } as object) : {})}
        >
          <Ph name="dots-three-vertical" size={14} color={c.text3} />
        </XStack>
      </Popover.Trigger>
      <Popover.Content
        backgroundColor={c.bgStep}
        borderWidth={1}
        borderColor={c.border}
        borderRadius={16}
        padding={6}
        elevate
        animation="quick"
        enterStyle={{ opacity: 0, y: -4 }}
        exitStyle={{ opacity: 0, y: -4 }}
        {...(WEB ? ({ style: { boxShadow: c.elevRaised } } as object) : {})}
      >
        <YStack minWidth={240} maxWidth={320}>
          <WindowMenuSection window={window} onDone={() => setOpen(false)} last />
        </YStack>
      </Popover.Content>
    </Popover>
  )
}

const MENU_W = 280

export function TabContextMenu({
  window,
  x,
  y,
  onClose,
  children,
}: {
  window: TabWindow
  x: number
  y: number
  onClose: () => void
  children?: React.ReactNode
}) {
  const c = useColors()
  useEffect(() => {
    if (!WEB) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  if (!WEB || typeof document === "undefined") return null
  const vw = document.documentElement.clientWidth || 1280
  const vh = document.documentElement.clientHeight || 800
  const left = Math.max(8, Math.min(x, vw - MENU_W - 8))
  const top = Math.max(8, Math.min(y, vh - 120))
  return createPortal(
    <div
      data-tab-context-scrim="true"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) onClose()
      }}
      style={{ position: "fixed", inset: 0, zIndex: 100000 }}
    >
      <div
        role="menu"
        data-testid={`tab-context-menu-${window.id}`}
        style={{
          position: "absolute",
          left,
          top,
          width: MENU_W,
          boxSizing: "border-box",
          maxHeight: vh - top - 8,
          overflowY: "auto",
          padding: 6,
          borderRadius: 16,
          background: c.bgStep,
          border: `1px solid ${c.border}`,
          boxShadow: c.elevRaised,
        }}
      >
        <WindowMenuSection window={window} onDone={onClose} last={!children} />
        {children}
      </div>
    </div>,
    document.body,
  )
}

const SETTLE_MS = 350

export function TabTitleInput({
  edit,
  style,
  testID = "window-title-input",
}: {
  edit: WindowTitleEdit
  style?: TextStyle
  testID?: string
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [value, setValue] = useState(edit.initial)
  const done = useRef(false)
  const born = useRef(Date.now())
  const input = useRef<TextInput | null>(null)
  const focus = () => {
    const el = input.current as unknown as HTMLInputElement | null
    el?.focus?.()
    el?.select?.()
  }
  useEffect(() => {
    focus()
    const again = setTimeout(focus, 80)
    return () => clearTimeout(again)
  }, [])
  const finish = (title: string | null) => {
    if (done.current) return
    done.current = true
    edit.onDone(title?.trim() ? title.trim() : null)
  }
  const stop = (e: { stopPropagation?: () => void }) => e.stopPropagation?.()
  return (
    <View
      style={{ flex: 1, minWidth: 0 }}
      {...({
        onClick: stop,
        onPointerDown: stop,
        onMouseDown: stop,
        onDoubleClick: stop,
      } as object)}
    >
      <TextInput
        ref={input}
        testID={testID}
        accessibilityLabel={t("windows.renameTitle", { defaultValue: "Rename" })}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={() => finish(value)}
        onBlur={() => {
          if (Date.now() - born.current < SETTLE_MS) setTimeout(focus, 0)
          else finish(null)
        }}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") finish(null)
        }}
        maxLength={200}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          {
            minWidth: 0,
            height: 22,
            paddingHorizontal: 4,
            marginHorizontal: -4,
            borderRadius: 5,
            backgroundColor: c.field,
            borderWidth: 1,
            borderColor: c.borderAccent,
            color: c.text,
            fontFamily: "Saans",
            fontSize: 13,
          },
          WEB ? ({ outlineStyle: "none" } as object) : null,
          style,
        ]}
      />
    </View>
  )
}
