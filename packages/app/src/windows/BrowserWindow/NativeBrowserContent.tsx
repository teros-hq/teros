/**
 * NativeBrowserContent — the desktop-shell half of the Browser window
 * (Teros Desktop F2, task tn_etrmG0vkwf4sQ6SJ · address bar: DBAB · agent
 * control toggle: DBAC).
 *
 * Inside the Teros Electron shell the "browser" window type stops being an
 * iframe (Plan A, frozen 30-oct) and becomes a REAL native browser pinned to
 * this window's rectangle:
 *
 *   toolbar    DOM, part of the SPA (URL bar, back/forward/reload/stop, the
 *              agent-control toggle) — the controls must be ours so they
 *              match the design system.
 *   content    NOT DOM. A placeholder <View> that RESERVES the rectangle and
 *              reports it (ResizeObserver + layout effects) to the main
 *              process, which clamps a WebContentsView to exactly those
 *              bounds. Native rendering: real logins (XFO does not apply),
 *              100% native text selection and scroll.
 *
 * The tab participates in the whole window system (move/split/desktops/
 * close) with zero special cases in the store: every layout change moves or
 * resizes the placeholder, the ResizeObserver fires, the main process
 * re-pins the view. Visibility (active tab? active desktop? overlay open?)
 * travels with every rect report — see `computeVisibility`.
 *
 * Overlays: a WebContentsView always composites ABOVE all DOM of its rect,
 * so while any modal overlay is open we report `visible:false` and the main
 * process hides the native view, letting the modal render on top. (There is
 * no per-pixel z-interleave between DOM and native views in Electron —
 * hiding while overlaid is the standard pattern. Documented in
 * docs/specs/20261031_desktop-f2-browser-window.md §4, Overlay rule.) The
 * signal is `useOverlayOpen` (services/overlayPresence.ts): the document is
 * watched for `aria-modal` content, which both modal primitives in Teros
 * (react-native-web Modal, Tamagui Dialog) emit — the permission sheet
 * included. The address bar's suggestion list follows the same rule from
 * the other side: it is rendered IN the layout, between the toolbar and the
 * placeholder, so the placeholder shrinks and the native view is re-pinned
 * below the list instead of painting over it.
 *
 * URL persistence: same contract as Plan A — `updateWindowProps(windowId,
 * { url })` — so dedupe (same URL → focus existing), session restore and
 * ui-state reports keep working unchanged. The native view's own navigations
 * (link clicks) are observed by the MAIN process and pushed back as
 * `teros-browser-state` events, which we mirror into the window props here
 * (url AND title — the tab is named after the page, DBAB-REQ-9).
 *
 * Address bar (docs/specs/20261031_desktop-browser-address-bar.md): free
 * text searches on the default engine, the field selects all on focus and
 * shows the full URL while editing, Escape/blur discard the draft,
 * Cmd/Ctrl+L focuses it — from the SPA (document key handler) or from
 * inside the page (the shell forwards it as `teros-browser-focus-url`) —
 * and, as the user types, a suggestion list (what Enter does, history,
 * provider completions) is one ArrowDown away.
 *
 * Agent control (docs/specs/20261031_desktop-browser-agent-control.md): the
 * toolbar's toggle is the ONLY way the user lets agents act in this tab; its
 * value comes from the shell's state push (`agentConsent`).
 */

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"
import { TabContext } from "../../components/workspace/TabContext"
import {
  type BrowserRect,
  type BrowserRectReason,
  type BrowserTabState,
  getDesktopBridge,
} from "../../services/desktopBridge"
import { useOverlayOpen } from "../../services/overlayPresence"
import { useTilingStore } from "../../store/tilingStore"
import {
  BookmarkRow,
  ConsentToggle,
  isBlankUrl,
  type SuggestFn,
  SuggestionList,
  ToolBtn,
  UrlField,
  type UrlFieldHandle,
  useBrowserInputStyles,
  useSuggestions,
} from "./BrowserToolbar"
import type { BrowserWindowProps } from "./definition"
import { canonicalUrl, resolveAddressInput, type SuggestionRow } from "./urlUtils"

/** Min width/height we ever report — degenerate rects are hidden, not sent. */
const MIN_RECT_PX = 2

interface Props extends BrowserWindowProps {
  windowId: string
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function NativeBrowserContent({ windowId, url: urlProp }: Props) {
  const c = useColors()
  const bridge = getDesktopBridge()
  const updateWindowProps = useTilingStore((s) => s.updateWindowProps)
  const activeDesktopIndex = useTilingStore((s) => s.activeDesktopIndex)
  const windowRecord = useTilingStore((s) => s.windows[windowId])
  const tabCtx = useContext(TabContext)

  // The native tab state as reported by the main process (url/title/nav).
  const [tab, setTab] = useState<BrowserTabState | null>(null)

  // URL we just asked for and the shell has not confirmed yet (DBAB-REQ-6):
  // the field shows it right after Enter instead of flashing the old URL.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  // Consent toggle value we just asked for, until the push confirms (DBAC-REQ-13).
  const [pendingConsent, setPendingConsent] = useState<boolean | null>(null)

  // The address field — focused by Cmd/Ctrl+L (document or shell-forwarded).
  const urlFieldRef = useRef<UrlFieldHandle | null>(null)

  // Placeholder element — its rect is what the main process pins to.
  const placeholderRef = useRef<View | null>(null)

  // ── Suggestions (DBAB-REQ-11/12) ─────────────────────────────────────────
  const [draft, setDraft] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const suggestFn = useMemo<SuggestFn | null>(() => {
    const fn = bridge?.invokeBrowserSuggest
    return fn ? (q: string) => fn.call(bridge, q) : null
  }, [bridge])
  const rows = useSuggestions(draft, suggestFn)
  // The highlight resets to row 1 whenever the draft changes (DBAB-REQ-12).
  useEffect(() => {
    setHighlight(0)
  }, [draft])
  const moveHighlight = useCallback(
    (delta: number) => {
      setHighlight((h) => Math.max(0, Math.min(rows.length - 1, h + delta)))
    },
    [rows.length],
  )
  const showList = draft !== null && draft.trim().length > 0 && rows.length > 0

  const isTabActive = tabCtx?.isTabActive ?? true
  const isContainerActive = tabCtx?.isContainerActive ?? true
  const isOnActiveDesktop =
    windowRecord?.desktopIndex === undefined || windowRecord.desktopIndex === activeDesktopIndex
  // F2 §4 Overlay rule — a modal open anywhere in the SPA (permission sheet,
  // confirm dialog…) would be painted UNDER the native view: hide it meanwhile.
  const overlayOpen = useOverlayOpen()

  /**
   * Whether the native view should be shown right now. Everything that
   * would put DOM on top of the rectangle (inactive tab, other desktop,
   * modal overlay open) collapses the view instead.
   */
  const visible = isTabActive && isOnActiveDesktop && !overlayOpen

  // ── Lifecycle: create the native tab on mount, destroy on unmount ────────
  useEffect(() => {
    if (!bridge) return
    let disposed = false
    const initial = canonicalUrl(urlProp)

    bridge.invokeBrowserCreate(windowId, initial).then((state) => {
      if (disposed || !state) return
      setTab(state)
    })
    const off = bridge.onBrowserState((state) => {
      if (state.windowId !== windowId) return
      setTab(state)
      setPendingUrl(null)
      setPendingConsent(null)
      // Mirror the native view's URL (and the page title, DBAB-REQ-9) into
      // the window props — persistence, dedupe, the tab's name and ui-state
      // reports keep working exactly like Plan A.
      if (state.url && !isBlankUrl(state.url)) {
        updateWindowProps(
          windowId,
          state.title ? { url: state.url, title: state.title } : { url: state.url },
        )
      }
    })
    return () => {
      disposed = true
      off()
      bridge.invokeBrowserDestroy(windowId)
    }
    // urlProp intentionally NOT in deps: create-once. Later prop changes
    // (history back/forward) are handled by the navigate-from-props effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, windowId])

  // ── Navigation requested through the window props (history back/forward,
  //    agent ui-commands) — the props change, the native view follows.
  const propUrl = canonicalUrl(urlProp)
  const lastAppliedPropUrl = useRef<string | null>(null)
  useEffect(() => {
    if (!bridge || !propUrl) return
    if (lastAppliedPropUrl.current === propUrl) return
    if (tab && tab.url === propUrl) {
      lastAppliedPropUrl.current = propUrl
      return
    }
    lastAppliedPropUrl.current = propUrl
    bridge.invokeBrowserNavigate(windowId, propUrl)
  }, [bridge, windowId, propUrl, tab])

  // ── Rect reporting: mount + every layout change + visibility flip ───────
  const reportRect = useCallback(
    (reason: BrowserRectReason) => {
      if (!bridge) return
      const el = placeholderRef.current
      if (!el) return
      const d = el as unknown as HTMLElement
      const r = d.getBoundingClientRect()
      const rect: BrowserRect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
      // A degenerate rect can still mean "hidden": inactive tabs and other
      // desktops keep the placeholder mounted with display:none (0×0 rect).
      // visible:false MUST still travel or the view never detaches — only
      // skip when a *visible* rect is too small to pin.
      if (visible && (rect.width < MIN_RECT_PX || rect.height < MIN_RECT_PX)) return
      bridge.sendBrowserRect(windowId, rect, visible, reason)
    },
    [bridge, windowId, visible],
  )

  // The placeholder only exists once the tab has content (the empty state
  // renders no placeholder). hasContent gates the observer effect so it
  // re-runs when the placeholder first mounts: on first render tab is null,
  // el is null and the effect would early-return and never attach the
  // ResizeObserver — the native view would never receive a rect.
  const hasContent = !!(tab && !isBlankUrl(tab.url))

  useEffect(() => {
    if (!bridge || !hasContent) return
    reportRect("mount")
    const d = placeholderRef.current as unknown as HTMLElement | null
    if (!d || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => reportRect("resize"))
    ro.observe(d)
    // Window resizes move every pane — catch the ones that don't resize the
    // placeholder itself (e.g. a pane that keeps its size but moves).
    const onWinResize = () => reportRect("layout")
    window.addEventListener("resize", onWinResize)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", onWinResize)
    }
  }, [bridge, reportRect, hasContent])

  // Visibility flips don't resize the placeholder — report them explicitly.
  useEffect(() => {
    reportRect("visibility")
  }, [reportRect])

  // @spec DBAB-REQ-14 — back to the new-tab page (history Back to the blank
  // start): the placeholder unmounts, so no observer will report again, yet
  // the native view is still pinned where the placeholder was and would
  // paint over the start page (clicks and keys would go to the blank page).
  // Tell the shell to hide it.
  const hadContent = useRef(false)
  useEffect(() => {
    if (hasContent) {
      hadContent.current = true
      return
    }
    if (!bridge || !hadContent.current) return
    hadContent.current = false
    bridge.sendBrowserRect(windowId, { x: 0, y: 0, width: 0, height: 0 }, false, "visibility")
  }, [bridge, windowId, hasContent])

  // The suggestion list opening/closing moves the placeholder (it sits in
  // the layout above it) — ResizeObserver catches the size change, this
  // catches the position-only case in the next frame.
  useEffect(() => {
    if (!hasContent || typeof requestAnimationFrame === "undefined") return
    const raf = requestAnimationFrame(() => reportRect("layout"))
    return () => cancelAnimationFrame(raf)
  }, [showList, rows.length, hasContent, reportRect])

  // ── Focus shortcut (DBAB-REQ-7) ──────────────────────────────────────────
  const focusUrlField = useCallback(() => urlFieldRef.current?.focus(), [])

  // (a) The SPA has keyboard focus: Cmd/Ctrl+L on the document, for the
  // browser window visible in the active container only.
  useEffect(() => {
    if (!bridge || !visible || !isContainerActive || typeof document === "undefined") return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key !== "l" && e.key !== "L") return
      e.preventDefault()
      focusUrlField()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [bridge, visible, isContainerActive, focusUrlField])

  // (b) The native page has keyboard focus: the shell consumed Cmd/Ctrl+L
  // and tells us which window it was for.
  useEffect(() => {
    if (!bridge?.onBrowserFocusUrl) return
    return bridge.onBrowserFocusUrl((id) => {
      if (id === windowId) focusUrlField()
    })
  }, [bridge, windowId, focusUrlField])

  // ── Toolbar actions ──────────────────────────────────────────────────────
  // @spec DBAB-REQ-6 — navigate, persist, show the URL until the shell confirms it.
  const openUrl = useCallback(
    (url: string) => {
      if (!bridge) return
      setDraft(null)
      setPendingUrl(url)
      lastAppliedPropUrl.current = url
      updateWindowProps(windowId, { url })
      bridge.invokeBrowserNavigate(windowId, url)
    },
    [bridge, updateWindowProps, windowId],
  )

  // @spec DBAB-REQ-1 — resolve (URL or search) what was typed.
  const navigate = useCallback(
    (raw: string) => {
      const resolved = resolveAddressInput(raw)
      if (!resolved) return
      openUrl(resolved.url)
    },
    [openUrl],
  )

  // @spec DBAB-REQ-12 — Enter submits the highlighted row; row 1 is the draft as typed.
  const submit = useCallback(
    (text: string, row: SuggestionRow | null) => {
      if (row && row.kind !== "resolve") openUrl(row.url)
      else navigate(text)
    },
    [navigate, openUrl],
  )
  const pickRow = useCallback(
    (row: SuggestionRow) => {
      if (row.kind === "resolve") navigate(row.label)
      else openUrl(row.url)
    },
    [navigate, openUrl],
  )

  const goBack = useCallback(() => {
    if (!bridge || !tab?.canGoBack) return
    bridge.invokeBrowserAction(windowId, "back")
  }, [bridge, tab, windowId])

  const goForward = useCallback(() => {
    if (!bridge || !tab?.canGoForward) return
    bridge.invokeBrowserAction(windowId, "forward")
  }, [bridge, tab, windowId])

  const reload = useCallback(() => {
    bridge?.invokeBrowserAction(windowId, "reload")
  }, [bridge, windowId])

  const stop = useCallback(() => {
    bridge?.invokeBrowserAction(windowId, "stop")
  }, [bridge, windowId])

  // @spec DBAC-REQ-13 — the agent-control toggle. Only shown when the shell
  // reports agentConsent (older shells have no gate to flip).
  const consentKnown = tab?.agentConsent !== undefined && !!bridge?.invokeBrowserSetConsent
  const consent = pendingConsent ?? tab?.agentConsent ?? false
  const toggleConsent = useCallback(() => {
    if (!bridge?.invokeBrowserSetConsent) return
    const next = !consent
    setPendingConsent(next)
    bridge
      .invokeBrowserSetConsent(windowId, next)
      .then((res) => {
        if (res && typeof res.agentConsent === "boolean") {
          setTab((t) => (t ? { ...t, agentConsent: res.agentConsent } : t))
        }
      })
      .catch(() => setPendingConsent(null))
  }, [bridge, consent, windowId])

  const { inputStyle, newTabInputStyle } = useBrowserInputStyles()

  // ── New-tab page: no URL yet (opened from the launcher) — DBAB-REQ-10/14 ──
  if (!tab || isBlankUrl(tab.url)) {
    return (
      <View
        testID="nbw-empty"
        style={{
          flex: 1,
          backgroundColor: c.bgSheet,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 20,
        }}
      >
        <View style={{ alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              backgroundColor: c.tile,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ph name="globe" size={28} color={c.accent} />
          </View>
          <T step="lg">Browser</T>
          <T step="sm" tone="text3">
            Search or enter a URL to open it in this window
          </T>
        </View>

        <View style={{ width: "100%", maxWidth: 640, gap: 8 }}>
          {/* @spec DBAB-REQ-10 — focused on open, same resolution as the toolbar. */}
          <UrlField
            ref={urlFieldRef}
            testID="nbw-empty-input"
            liveUrl={pendingUrl ?? ""}
            onSubmit={submit}
            onDraftChange={setDraft}
            rows={rows}
            highlight={highlight}
            onMoveHighlight={moveHighlight}
            autoFocus
            style={newTabInputStyle}
          />
          {showList ? (
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.bgStep,
                paddingHorizontal: 4,
              }}
            >
              <SuggestionList
                testID="nbw-suggestions"
                rows={rows}
                highlight={highlight}
                onHighlight={setHighlight}
                onPick={pickRow}
              />
            </View>
          ) : null}
        </View>

        <BookmarkRow onOpen={navigate} />
      </View>
    )
  }

  // ── Toolbar + native placeholder ──
  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 44,
          paddingHorizontal: 10,
          paddingVertical: 6,
          backgroundColor: c.bgSheet,
          borderBottomWidth: showList ? 0 : 1,
          borderBottomColor: c.border,
        }}
      >
        <ToolBtn
          icon="arrow-left"
          label="Back"
          onPress={goBack}
          disabled={!tab.canGoBack}
          testID="nbw-back"
        />
        <ToolBtn
          icon="arrow-right"
          label="Forward"
          onPress={goForward}
          disabled={!tab.canGoForward}
          testID="nbw-forward"
        />
        {tab.loading ? (
          <ToolBtn icon="x" label="Stop" onPress={stop} testID="nbw-stop" />
        ) : (
          <ToolBtn icon="arrow-clockwise" label="Reload" onPress={reload} testID="nbw-reload" />
        )}
        <UrlField
          ref={urlFieldRef}
          testID="nbw-url"
          liveUrl={pendingUrl ?? tab.url}
          onSubmit={submit}
          onDraftChange={setDraft}
          rows={rows}
          highlight={highlight}
          onMoveHighlight={moveHighlight}
          style={inputStyle}
        />
        {consentKnown ? <ConsentToggle consent={consent} onToggle={toggleConsent} /> : null}
      </View>

      {/*
       * The suggestion list sits IN the layout, under the toolbar: the native
       * view would paint over anything positioned above the placeholder, so
       * the placeholder shrinks instead and the view is re-pinned below the
       * list (DBAB-REQ-11, F2 §Overlays).
       */}
      {showList ? (
        <View
          style={{
            paddingHorizontal: 8,
            paddingBottom: 6,
            backgroundColor: c.bgSheet,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <SuggestionList
            testID="nbw-suggestions"
            rows={rows}
            highlight={highlight}
            onHighlight={setHighlight}
            onPick={pickRow}
          />
        </View>
      ) : null}

      {/*
       * The placeholder. Its ONLY job is to reserve the rectangle: the main
       * process pins the native WebContentsView to exactly these bounds. It
       * must stay in the layout (flex:1) even when the tab is inactive —
       * TilingContainer keeps inactive tabs mounted with display:none, which
       * zeroes the rect; the visibility flag (not the rect) tells the main
       * process to hide the view. A quiet background color shows through
       * during the first paint, before the native view lands.
       */}
      <View
        ref={placeholderRef}
        testID="nbw-placeholder"
        style={{ flex: 1, backgroundColor: c.bgInner }}
      />
    </View>
  )
}
