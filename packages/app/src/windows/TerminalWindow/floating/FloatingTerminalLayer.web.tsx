/**
 * FloatingTerminalLayer — floating terminals over the whole app (the chat
 * included), above the tiling system and outside it: mounted once at the
 * app shell next to the voice orb. Renders, for the active workspace:
 *   - a FloatingTerminal per floating, non-minimised terminal (wide app),
 *   - a FloatBubble per minimised one — and for every one when the app is
 *     narrower than NARROW_FLOAT_WIDTH, where tapping a bubble opens a sheet,
 *   - the ghost of a face being dragged out of a crew rail.
 * Floating terminals whose session is gone are docked (dropped) here.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useMcaTheme } from "../../../components/mca/primitives/useColors"
import { useNavbarStore } from "../../../store/navbarStore"
import { useTilingStore } from "../../../store/tilingStore"
import { useWorkspaceStore } from "../../../store/workspaceStore"
import { Face } from "../crew"
import { crewMotion } from "../crew/crewMotion"
import { useK } from "../crew/tokens"
import { TerminalView } from "../TerminalView"
import { type TerminalSession, useTerminalSessions } from "../terminalSessions"
import { BUBBLE, FloatBubble } from "./FloatBubble.web"
import { FloatHeader } from "./FloatHeader.web"
import { closeTerminal, dockAndSelect, FloatingTerminal, takeWheel } from "./FloatingTerminal.web"
import { NARROW_FLOAT_WIDTH } from "./floatGeometry"
import { useTerminalFloatStore } from "./terminalFloatStore"

const BUBBLE_GAP = 12
/** Bubbles stack up from here (clear of the chat composer). */
const BUBBLE_BOTTOM = 108
/** Sidebar widths (Navbar.tsx): bubbles sit just right of it, over the canvas. */
const NAVBAR_W = { expanded: 272, collapsed: 64 }

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_FLOAT_WIDTH)
  useEffect(() => {
    const onResize = () => {
      setNarrow(window.innerWidth < NARROW_FLOAT_WIDTH)
      useTerminalFloatStore.getState().fitViewport()
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return narrow
}

/** Which floating terminal's page has the keyboard (an iframe inside it is focused). */
function useKeyboardOwner(): [string | null, (id: string | null) => void] {
  const [owner, setOwner] = useState<string | null>(null)
  useEffect(() => {
    const check = () => {
      const el = document.activeElement
      const host =
        el instanceof HTMLIFrameElement
          ? el.closest("[data-floating-terminal],[data-float-sheet]")
          : null
      setOwner(
        host
          ? (host.getAttribute("data-floating-terminal") ?? host.getAttribute("data-float-sheet"))
          : null,
      )
    }
    // Focus moving into an iframe blurs this window; coming back focuses it.
    const later = () => setTimeout(check, 0)
    window.addEventListener("blur", later)
    window.addEventListener("focus", later)
    document.addEventListener("focusin", later)
    return () => {
      window.removeEventListener("blur", later)
      window.removeEventListener("focus", later)
      document.removeEventListener("focusin", later)
    }
  }, [])
  return [owner, setOwner]
}

export function FloatingTerminalLayer() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const restoredFor = useTilingStore((s) => s.layoutRestoredForWorkspace)
  const floating = useTerminalFloatStore((s) => s.floating)
  const hydratedFor = useTerminalFloatStore((s) => s.hydratedFor)
  const drag = useTerminalFloatStore((s) => s.drag)
  const { sessions, loaded } = useTerminalSessions(workspaceId)
  const narrow = useNarrow()
  const navExpanded = useNavbarStore((s) => s.isExpanded)
  const [keyboard, setKeyboard] = useKeyboardOwner()
  const [sheet, setSheet] = useState<string | null>(null)

  useEffect(() => {
    crewMotion()
  }, [])

  // The workspace's desktop-state is loaded once its layout was restored.
  useEffect(() => {
    if (workspaceId && restoredFor === workspaceId) {
      void useTerminalFloatStore.getState().hydrate(workspaceId)
    }
  }, [workspaceId, restoredFor])

  const byId = useMemo(() => {
    const m = new Map<string, TerminalSession>()
    for (const s of sessions) m.set(s.terminalId, s)
    return m
  }, [sessions])

  const ready = !!workspaceId && hydratedFor === workspaceId

  // A session that ended (or never came back) stops floating.
  useEffect(() => {
    if (!ready || !loaded) return
    for (const id of Object.keys(floating))
      if (!byId.has(id)) useTerminalFloatStore.getState().dock(id)
  }, [ready, loaded, floating, byId])

  useEffect(() => {
    if (sheet && (!floating[sheet] || !narrow)) setSheet(null)
  }, [sheet, floating, narrow])

  if (!ready) return drag ? <Ghost drag={drag} session={byId.get(drag.terminalId)} /> : null

  const ids = Object.keys(floating).sort((a, b) => floating[a].z - floating[b].z)
  const windows = narrow ? [] : ids.filter((id) => !floating[id].minimized)
  const bubbles = narrow ? ids : ids.filter((id) => floating[id].minimized)
  const front = windows[windows.length - 1]
  const vh = window.innerHeight

  return (
    <div
      data-floating-terminal-layer=""
      style={{ position: "fixed", inset: 0, zIndex: 80, pointerEvents: "none", overflow: "hidden" }}
    >
      {windows.map((id) => (
        <FloatingTerminal
          key={id}
          terminalId={id}
          entry={floating[id]}
          session={byId.get(id)}
          front={id === front}
          keyboard={keyboard === id}
          onKeyboard={setKeyboard}
        />
      ))}
      {bubbles.map((id, i) => (
        <FloatBubble
          key={id}
          terminalId={id}
          session={byId.get(id)}
          x={
            narrow
              ? window.innerWidth - BUBBLE - 16
              : (navExpanded ? NAVBAR_W.expanded : NAVBAR_W.collapsed) + 20
          }
          y={vh - BUBBLE_BOTTOM - BUBBLE - i * (BUBBLE + BUBBLE_GAP)}
          labelSide={narrow ? "left" : "right"}
          onOpen={() => {
            if (narrow) setSheet(id)
            else useTerminalFloatStore.getState().focus(id)
          }}
        />
      ))}
      {sheet ? (
        <Sheet
          terminalId={sheet}
          session={byId.get(sheet)}
          keyboard={keyboard === sheet}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {drag ? <Ghost drag={drag} session={byId.get(drag.terminalId)} /> : null}
    </div>
  )
}

/** Narrow app: a floating terminal opens as a sheet over the bottom 64 %. */
function Sheet({
  terminalId,
  session,
  keyboard,
  onClose,
}: {
  terminalId: string
  session: TerminalSession | undefined
  keyboard: boolean
  onClose: () => void
}) {
  const K = useK()
  const theme = useMcaTheme()
  return (
    <>
      <div
        onPointerDown={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: K.sheetScrim,
          pointerEvents: "auto",
          zIndex: 600,
        }}
      />
      <div
        data-float-sheet={terminalId}
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          bottom: 0,
          height: "64%",
          zIndex: 601,
          display: "flex",
          flexDirection: "column",
          background: K.floatBg,
          borderRadius: "16px 16px 0 0",
          overflow: "hidden",
          pointerEvents: "auto",
          boxShadow: K.floatSheetShadow,
          animation: "crew-pop-in 180ms ease-out",
        }}
      >
        <div
          style={{ height: 14, display: "grid", placeItems: "center", background: K.floatHeaderBg }}
        >
          <span style={{ width: 36, height: 4, borderRadius: 2, background: K.floatHandle }} />
        </div>
        <FloatHeader
          terminalId={terminalId}
          session={session}
          keyboard={keyboard}
          mode="sheet"
          onTakeWheel={() => takeWheel(terminalId)}
          onDock={() => {
            onClose()
            dockAndSelect(terminalId)
          }}
          onCloseTerminal={() => {
            onClose()
            closeTerminal(terminalId)
          }}
        />
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
          <TerminalView
            terminalId={terminalId}
            theme={theme}
            optionIsMeta={false}
            background={K.floatBg}
            onLive={() => {}}
          />
        </div>
      </div>
    </>
  )
}

/** The face under the pointer while it's dragged out of the rail. */
function Ghost({
  drag,
  session,
}: {
  drag: { terminalId: string; x: number; y: number; overRail: boolean }
  session: TerminalSession | undefined
}) {
  const K = useK()
  const { t } = useTranslation()
  return (
    <div
      style={{
        position: "fixed",
        left: drag.x,
        top: drag.y,
        zIndex: 1000,
        pointerEvents: "none",
        lineHeight: 0,
        transform: `translate(-50%,-50%) rotate(${drag.overRail ? 0 : -4}deg)`,
        filter: K.ghostShadow,
        transition: "transform .12s",
      }}
    >
      <Face session={session} terminalId={drag.terminalId} size={44} />
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "calc(100% + 10px)",
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          padding: "4px 9px",
          borderRadius: 999,
          background: K.ghostBg,
          color: K.ghostText,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 11.5,
          lineHeight: 1.3,
        }}
      >
        {drag.overRail
          ? t("terminal.float.dropBack", { defaultValue: "Drop to keep it in the crew" })
          : t("terminal.float.dropToFloat", { defaultValue: "Drop to float it here" })}
      </span>
    </div>
  )
}
