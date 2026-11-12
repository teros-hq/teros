/**
 * The slim header of a floating terminal (and of the narrow sheet): face +
 * seat, name, who drives, then one action for the seat (take the wheel), the
 * "keyboard here" pill on the focused window, a ⋯ menu (back to the Terminal
 * window, close the terminal), minimise, and back to the Terminal window.
 * The header is the drag handle; its buttons are not.
 */

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useAuthStore } from "../../../store/authStore"
import { describeSeat, driverLine, Face, SEAT_COLORS, Seat } from "../crew"
import { useK } from "../crew/tokens"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import { closeNeedsConfirm } from "./closeRule"
import { FloatIcon } from "./floatIcons.web"

interface Props {
  terminalId: string
  session: TerminalSession | undefined
  /** The keyboard is in this window. */
  keyboard: boolean
  mode: "floating" | "sheet"
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
  onTakeWheel: () => void
  onDock: () => void
  onMinimize?: () => void
  /** End the session (terminal.destroy). */
  onCloseTerminal: () => void
}

export function FloatHeader({
  terminalId,
  session,
  keyboard,
  mode,
  onPointerDown,
  onTakeWheel,
  onDock,
  onMinimize,
  onCloseTerminal,
}: Props) {
  const K = useK()
  const { t } = useTranslation()
  const me = useAuthStore((s) => s.user?.userId)
  const view = session ? describeSeat(session, me, Date.now()) : null
  const line = view ? driverLine(view, me) : null
  const need = view?.seat === "need"
  const canTake = view?.seat === "agent" || need

  return (
    <div
      data-float-header=""
      onPointerDown={onPointerDown}
      style={{
        flex: "none",
        height: 44,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 8px 0 10px",
        background: need ? K.floatNeedGrad : K.floatHeaderBg,
        borderBottom: `1px solid ${need ? K.floatNeedLine : K.floatHeaderLine}`,
        color: K.text,
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 12.5,
        whiteSpace: "nowrap",
        cursor: mode === "floating" ? "grab" : "default",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
      }}
    >
      <div style={{ position: "relative", lineHeight: 0, marginRight: 4, flex: "none" }}>
        <Face session={session} terminalId={terminalId} size={26} />
        {session ? (
          <Seat
            session={session}
            size={14}
            gap={need ? K.needBg : K.floatHeaderBg}
            corner
            offset={5}
          />
        ) : null}
      </div>
      <div
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          lineHeight: 1.3,
        }}
      >
        <b
          style={{ fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {session
            ? sessionLabel(session)
            : t("terminal.float.untitled", { defaultValue: "Terminal" })}
        </b>
        {line ? (
          <span
            style={{ fontSize: 11, color: K.dim2, overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {line.who ? <b style={{ color: line.color, fontWeight: 600 }}>{line.who}</b> : null}
            {line.who ? " " : null}
            <span style={line.who ? undefined : { color: K.text2 }}>{line.rest}</span>
          </span>
        ) : null}
      </div>
      {need ? (
        <HeaderButton
          amber
          onClick={onTakeWheel}
          title={t("terminal.float.takeWheel", { defaultValue: "Take the wheel" })}
        >
          <FloatIcon name="wheel" size={13} />
          {t("terminal.float.take", { defaultValue: "Take" })}
        </HeaderButton>
      ) : canTake ? (
        <IconButton
          onClick={onTakeWheel}
          title={t("terminal.float.takeWheel", { defaultValue: "Take the wheel" })}
        >
          <FloatIcon name="wheel" size={14} />
        </IconButton>
      ) : null}
      {keyboard ? (
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 8px",
            borderRadius: 999,
            background: K.floatPill,
            color: K.text,
            fontSize: 10.5,
            fontWeight: 600,
            flex: "none",
          }}
        >
          <FloatIcon name="keyboard" size={11} />
          {t("terminal.float.keyboardHere", { defaultValue: "keyboard here" })}
        </span>
      ) : null}
      <MoreMenu
        onDock={onDock}
        onCloseTerminal={onCloseTerminal}
        confirm={closeNeedsConfirm(session, me)}
      />
      {onMinimize ? (
        <IconButton
          onClick={onMinimize}
          title={t("terminal.float.minimize", { defaultValue: "Minimise to a bubble" })}
        >
          <FloatIcon name="min" size={13} />
        </IconButton>
      ) : null}
      <IconButton
        testID="float-dock"
        onClick={onDock}
        title={t("terminal.float.dock", {
          defaultValue: "Back to the Terminal window (it keeps running)",
        })}
      >
        <FloatIcon name="dock" size={14} />
      </IconButton>
    </div>
  )
}

/** ⋯ → Back to the Terminal window · Close terminal (asks again when it would cut something off). */
function MoreMenu({
  onDock,
  onCloseTerminal,
  confirm,
}: {
  onDock: () => void
  onCloseTerminal: () => void
  confirm: boolean
}) {
  const K = useK()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [arming, setArming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      setArming(false)
      return
    }
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("pointerdown", away, true)
    window.addEventListener("keydown", esc)
    return () => {
      window.removeEventListener("pointerdown", away, true)
      window.removeEventListener("keydown", esc)
    }
  }, [open])

  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <IconButton
        testID="float-more"
        active={open}
        onClick={() => setOpen((o) => !o)}
        title={t("terminal.float.more", { defaultValue: "More" })}
      >
        <FloatIcon name="more" size={14} />
      </IconButton>
      {open ? (
        <div
          role="menu"
          onPointerDown={stop}
          style={{
            position: "absolute",
            right: 0,
            top: 34,
            zIndex: 40,
            width: 284,
            padding: 6,
            borderRadius: 12,
            background: K.card,
            boxShadow: `${K.shadowCard},0 0 0 1px ${K.cardLine} inset`,
            color: K.text,
            fontSize: 12.5,
            animation: "crew-pop-in 120ms ease-out",
          }}
        >
          <MenuItem
            icon="dock"
            onClick={() => {
              setOpen(false)
              onDock()
            }}
            hint={t("terminal.float.dockHint", { defaultValue: "keeps running" })}
          >
            {t("terminal.float.dockItem", { defaultValue: "Back to the Terminal window" })}
          </MenuItem>
          <div style={{ height: 1, background: K.cardSep, margin: "5px 2px" }} />
          <MenuItem
            testID="float-close-terminal"
            icon={arming ? "check" : "trash"}
            danger
            onClick={() => {
              if (confirm && !arming) {
                setArming(true)
                return
              }
              setOpen(false)
              onCloseTerminal()
            }}
            hint={arming ? undefined : t("terminal.float.closeHint", { defaultValue: "ends it" })}
          >
            {arming
              ? t("terminal.float.closeConfirm", { defaultValue: "Click again to close it" })
              : t("terminal.float.close", { defaultValue: "Close terminal" })}
          </MenuItem>
        </div>
      ) : null}
    </div>
  )
}

function MenuItem({
  children,
  icon,
  onClick,
  hint,
  danger,
  testID,
}: {
  children: React.ReactNode
  icon: "dock" | "trash" | "check"
  onClick: () => void
  hint?: string
  danger?: boolean
  testID?: string
}) {
  const K = useK()
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testID}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 9,
        height: 30,
        padding: "0 8px",
        border: 0,
        borderRadius: 7,
        background: hover ? K.menuHover : "transparent",
        color: danger ? K.dangerText : K.menuText,
        fontFamily: "inherit",
        fontSize: 12.5,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <FloatIcon name={icon} size={13} />
      <span style={{ flex: 1 }}>{children}</span>
      {hint ? <span style={{ fontSize: 10.5, color: K.dim2 }}>{hint}</span> : null}
    </button>
  )
}

/** Buttons stop the press so it doesn't start a window drag. */
function stop(e: React.PointerEvent) {
  e.stopPropagation()
}

function IconButton({
  children,
  onClick,
  title,
  testID,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  testID?: string
  active?: boolean
}) {
  const K = useK()
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testID}
      onPointerDown={stop}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        display: "grid",
        placeItems: "center",
        color: hover || active ? K.textHi : K.text3,
        background: hover || active ? K.btn : "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        flex: "none",
      }}
    >
      {children}
    </button>
  )
}

function HeaderButton({
  children,
  onClick,
  title,
  amber,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  amber?: boolean
}) {
  const K = useK()
  return (
    <button
      type="button"
      title={title}
      onPointerDown={stop}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 10px",
        borderRadius: 8,
        border: 0,
        background: amber ? SEAT_COLORS.need.ring : K.btn,
        color: amber ? K.amberInk : K.textHi,
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        flex: "none",
      }}
    >
      {children}
    </button>
  )
}
