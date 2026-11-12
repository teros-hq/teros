/**
 * BrowserWindowContent — the web-mode content of the "browser" window type:
 * a VISIBLE TAB of the Browser MCA (docs/specs/20261104_browser-mca-visible.md,
 * BRW-REQ-8), streamed with MCA streams (20261104_mca-streams.md).
 *
 * Outside the Teros desktop shell there is no WebContentsView to pin, so the
 * window asks the workspace's Browser app for a tab (`browser-view`, the
 * window id is the tab id), takes a `stream.ticket` and attaches to the tab's
 * stream: frames paint a <canvas>, the person's mouse, wheel, keyboard and
 * paste go back as `in` inputs that the MCA turns into trusted CDP events —
 * the page sees real events, no script runs inside it. The toolbar is the
 * desktop browser's (DBAB address bar with suggestions, DBAC consent toggle),
 * from BrowserToolbar.tsx. Agents drive the same tab with the Browser MCA's
 * own tools.
 *
 * Fallbacks: no Browser app in the workspace → "Browser is off" (testID
 * bw-browser-off); a server without MCA streams → the "desktop only" state
 * (testID bw-desktop-only). Never an iframe.
 *
 * URL persistence: same contract as the native window — `updateWindowProps
 * (windowId, { url, title })` on every state push, so dedupe, session restore
 * and ui-state reports keep working unchanged; prop URL changes (history,
 * agent open-window) send a `navigate` input.
 */

import type React from "react"
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { EmptyState, Ph, T } from "../../components/ui/ds"
import { TabContext } from "../../components/workspace/TabContext"
import type { BrowserSuggestResponse } from "../../services/desktopBridge"
import type { StreamConnection } from "../../services/streams/streamClient"
import { useTilingStore } from "../../store/tilingStore"
import { getActiveWorkspaceId } from "../../store/workspaceStoreRef"
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
import { createBrowserStream, findBrowserApp, requestSuggest, requestView } from "./browserStream"
import {
  buttonName,
  type CloudTabState,
  heldButton,
  type InputFrame,
  keyFrame,
  modsOf,
  toPageCoords,
  wheelDeltas,
} from "./cloudBrowserProtocol"
import type { BrowserWindowProps } from "./definition"
import { canonicalUrl, resolveAddressInput, type SuggestionRow } from "./urlUtils"

interface Props extends BrowserWindowProps {
  windowId: string
}

/** Where the "Get the desktop app" CTA points. */
const DESKTOP_APP_URL = "https://teros.ai"

/** Mouse moves are sent at most this often (CLB-REQ-9). */
const MOVE_MIN_INTERVAL_MS = 16
/** Size reports are debounced (CLB-REQ-9). */
const RESIZE_DEBOUNCE_MS = 250

type ConnStatus = "connecting" | "live" | "offline" | "unavailable" | "closed" | "no-app"

// ─── Desktop-only fallback (1-nov) ──────────────────────────────────────────

function DesktopOnly() {
  const { t } = useTranslation()
  const c = useColors()
  const openLanding = () => {
    if (Platform.OS === "web") window.open(DESKTOP_APP_URL, "_blank", "noopener,noreferrer")
  }
  return (
    <View
      testID="bw-desktop-only"
      style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}
    >
      <EmptyState
        icon="monitor"
        title={t("windows.browserDesktopOnly")}
        text={t("windows.browserDesktopOnlyText")}
        action={
          Platform.OS === "web" ? (
            <Pressable
              testID="bw-desktop-only-cta"
              onPress={openLanding}
              accessibilityRole="button"
              accessibilityLabel={t("windows.browserDesktopOnlyCta")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 10,
                backgroundColor: c.navActive,
                borderWidth: 1,
                borderColor: c.borderAccent,
              }}
            >
              <Ph name="arrow-square-out" size={14} color={c.accent} />
              <T step="codenote" style={{ color: c.accent }}>
                {t("windows.browserDesktopOnlyCta")}
              </T>
            </Pressable>
          ) : undefined
        }
      />
    </View>
  )
}

/** The workspace has no Browser app: the capability is off (BRW-REQ-8). */
function BrowserOff() {
  const c = useColors()
  return (
    <View
      testID="bw-browser-off"
      style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}
    >
      <EmptyState
        icon="globe"
        title="Browser is off in this workspace"
        text="Enable the Browser capability for your agents in the workspace's apps, then reopen this window."
      />
    </View>
  )
}

// ─── The visible tab ────────────────────────────────────────────────────────

export function BrowserWindowContent({ windowId, url: urlProp }: Props) {
  const c = useColors()
  const updateWindowProps = useTilingStore((s) => s.updateWindowProps)
  const activeDesktopIndex = useTilingStore((s) => s.activeDesktopIndex)
  const windowRecord = useTilingStore((s) => s.windows[windowId])
  const tabCtx = useContext(TabContext)
  const isTabActive = tabCtx?.isTabActive ?? true
  const isOnActiveDesktop =
    windowRecord?.desktopIndex === undefined || windowRecord.desktopIndex === activeDesktopIndex
  const visible = isTabActive && isOnActiveDesktop

  const [status, setStatus] = useState<ConnStatus>("connecting")
  const [tab, setTab] = useState<CloudTabState | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [pendingConsent, setPendingConsent] = useState<boolean | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameBoxRef = useRef<View | null>(null)
  const urlFieldRef = useRef<UrlFieldHandle | null>(null)
  const connRef = useRef<StreamConnection | null>(null)
  const appIdRef = useRef<string | null>(null)
  /** CSS size of the frames (from frame-meta) — the input coordinate space. */
  const cssRef = useRef<{ width: number; height: number }>({ width: 1280, height: 800 })
  /** The MCA stream this window is attached to (from browser-view). */
  const streamIdRef = useRef<string | null>(null)
  const lastMoveAt = useRef(0)
  const latestBitmap = useRef<ImageBitmap | HTMLImageElement | null>(null)
  const drawPending = useRef(false)

  // ── Suggestions (DBAB-REQ-11/12 → CLB-REQ-10) ─────────────────────────────
  const [draft, setDraft] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const suggestFn = useMemo<SuggestFn | null>(
    () => (q: string) => {
      const appId = appIdRef.current
      if (!appId) return Promise.resolve(null)
      return requestSuggest(appId, q).then((r) => r as BrowserSuggestResponse | null)
    },
    [],
  )
  const rows = useSuggestions(draft, suggestFn)
  // The highlight resets to row 1 whenever the draft changes (DBAB-REQ-12).
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the trigger, not a value the effect reads
  useEffect(() => {
    setHighlight(0)
  }, [draft])
  const moveHighlight = useCallback(
    (delta: number) => setHighlight((h) => Math.max(0, Math.min(rows.length - 1, h + delta))),
    [rows.length],
  )
  const showList = draft !== null && draft.trim().length > 0 && rows.length > 0

  // ── Painting ──────────────────────────────────────────────────────────────
  const paint = useCallback(() => {
    drawPending.current = false
    const canvas = canvasRef.current
    const img = latestBitmap.current
    if (!canvas || !img) return
    const w = (img as ImageBitmap).width
    const h = (img as ImageBitmap).height
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(img as CanvasImageSource, 0, 0)
  }, [])

  const onFrame = useCallback(
    (jpeg: Uint8Array) => {
      if (typeof Blob === "undefined") return
      const blob = new Blob([jpeg as unknown as BlobPart], { type: "image/jpeg" })
      const commit = (img: ImageBitmap | HTMLImageElement) => {
        const prev = latestBitmap.current
        latestBitmap.current = img
        if (prev && "close" in prev && typeof (prev as ImageBitmap).close === "function")
          (prev as ImageBitmap).close()
        if (!drawPending.current) {
          drawPending.current = true
          requestAnimationFrame(paint)
        }
      }
      if (typeof createImageBitmap === "function") {
        createImageBitmap(blob).then(commit, () => {})
      } else {
        const img = new Image()
        const url = URL.createObjectURL(blob)
        img.onload = () => {
          URL.revokeObjectURL(url)
          commit(img)
        }
        img.src = url
      }
    },
    [paint],
  )

  // ── Connection lifecycle ──────────────────────────────────────────────────
  const workspaceId = getActiveWorkspaceId() ?? ""
  // biome-ignore lint/correctness/useExhaustiveDependencies: attach-once — urlProp changes are handled by the navigate-from-props effect; updateWindowProps is a stable store action
  useEffect(() => {
    if (Platform.OS !== "web") {
      setStatus("unavailable")
      return
    }
    let disposed = false
    const applyState = (state: CloudTabState) => {
      setTab(state)
      setPendingUrl(null)
      setPendingConsent(null)
      // Mirror the tab's URL and title into the window props (persistence,
      // dedupe, the tab's name, ui-state reports) — same as the native window.
      if (state.url && !isBlankUrl(state.url)) {
        updateWindowProps(
          windowId,
          state.title ? { url: state.url, title: state.title } : { url: state.url },
        )
      }
    }
    const conn = createBrowserStream({
      frame: (id, kind, payload) => {
        if (kind === 1 && id === streamIdRef.current) onFrame(payload)
      },
      attached: (id, _kind, state) => {
        if (id === streamIdRef.current) applyState(state as unknown as CloudTabState)
      },
      state: (id, state) => {
        if (id === streamIdRef.current) applyState(state as unknown as CloudTabState)
      },
      closed: (id, reason) => {
        if (id !== streamIdRef.current) return
        setStatus("closed")
        setLastError(reason)
      },
      error: (code, msg) => {
        setLastError(msg ? `${code}: ${msg}` : code)
      },
      status: (s) => setStatus(s),
    })
    connRef.current = conn
    const box = frameBoxRef.current as unknown as HTMLElement | null
    const rect = box?.getBoundingClientRect?.()
    const width = Math.max(200, Math.round(rect?.width || 1280))
    const height = Math.max(150, Math.round(rect?.height || 800))
    cssRef.current = { width, height }
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
    ;(async () => {
      try {
        const app = await findBrowserApp(workspaceId)
        if (disposed) return
        if (!app) {
          setStatus("no-app")
          return
        }
        appIdRef.current = app.appId
        const view = await requestView(app.appId, {
          tabId: windowId,
          url: canonicalUrl(urlProp),
          width,
          height,
        })
        if (disposed) return
        streamIdRef.current = view.streamId
        if (view.state) applyState(view.state)
        conn.attachStream({ id: view.streamId, meta: { width, height, dpr } })
        conn.open()
      } catch (err) {
        if (disposed) return
        const code = (err as { code?: string })?.code
        setLastError(err instanceof Error ? err.message : String(err))
        // No MCA system / no app → the capability is not here; anything else is a hiccup.
        setStatus(
          code === "MCA_UNAVAILABLE" || code === "APP_NOT_FOUND" || code === "ACCESS_DENIED"
            ? "no-app"
            : "offline",
        )
      }
    })()
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") conn.wake()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      document.removeEventListener("visibilitychange", onVisibility)
      connRef.current = null
      // Unmount = the window closed (or moved: the store remounts it and a
      // fresh attach within the MCA's grace finds the same tab).
      conn.dispose()
    }
  }, [windowId, workspaceId, onFrame])

  // ── Navigation requested through the window props (history, agent) ───────
  const propUrl = canonicalUrl(urlProp)
  const lastAppliedPropUrl = useRef<string | null>(propUrl ?? null)
  useEffect(() => {
    if (!propUrl || lastAppliedPropUrl.current === propUrl) return
    if (tab && tab.url === propUrl) {
      lastAppliedPropUrl.current = propUrl
      return
    }
    lastAppliedPropUrl.current = propUrl
    connRef.current?.input({ k: "navigate", url: propUrl })
  }, [propUrl, tab])

  // ── Size reporting (ResizeObserver, debounced) ────────────────────────────
  const hasContent = !!(tab && !isBlankUrl(tab.url)) || !!pendingUrl
  useEffect(() => {
    if (!hasContent) return
    const el = frameBoxRef.current as unknown as HTMLElement | null
    if (!el || typeof ResizeObserver === "undefined") return
    let timer: ReturnType<typeof setTimeout> | null = null
    const report = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 50 || r.height < 50) return
      const width = Math.round(r.width)
      const height = Math.round(r.height)
      const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
      // The MCA sizes the tab's window to this box: frames are this many CSS px.
      cssRef.current = { width, height }
      connRef.current?.setMeta({ width, height, dpr })
      connRef.current?.input({ k: "resize", width, height, dpr })
    }
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(report, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(el)
    report()
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [hasContent])

  // ── Toolbar actions ───────────────────────────────────────────────────────
  const openUrl = useCallback(
    (url: string) => {
      setDraft(null)
      setPendingUrl(url)
      lastAppliedPropUrl.current = url
      updateWindowProps(windowId, { url })
      connRef.current?.input({ k: "navigate", url })
    },
    [updateWindowProps, windowId],
  )
  const navigate = useCallback(
    (raw: string) => {
      const resolved = resolveAddressInput(raw)
      if (resolved) openUrl(resolved.url)
    },
    [openUrl],
  )
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
  const goBack = useCallback(() => connRef.current?.input({ k: "action", action: "back" }), [])
  const goForward = useCallback(
    () => connRef.current?.input({ k: "action", action: "forward" }),
    [],
  )
  const reload = useCallback(() => connRef.current?.input({ k: "action", action: "reload" }), [])
  const stop = useCallback(() => connRef.current?.input({ k: "action", action: "stop" }), [])

  // @spec DBAC-REQ-13 (on the cloud tab): the toggle is the only consent path.
  const consent = pendingConsent ?? tab?.agentConsent ?? false
  const toggleConsent = useCallback(() => {
    const next = !consent
    setPendingConsent(next)
    connRef.current?.input({ k: "consent", enabled: next })
  }, [consent])

  // Cmd/Ctrl+L focuses the address field while this window is visible.
  const focusUrlField = useCallback(() => urlFieldRef.current?.focus(), [])
  useEffect(() => {
    if (!visible || typeof document === "undefined") return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key !== "l" && e.key !== "L") return
      e.preventDefault()
      focusUrlField()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [visible, focusUrlField])

  // ── Input on the canvas (CLB-REQ-6/9) ─────────────────────────────────────
  const pageCoords = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    return toPageCoords(e.clientX, e.clientY, canvas.getBoundingClientRect(), cssRef.current)
  }, [])

  const sendInput = useCallback((frame: InputFrame) => {
    const { t: _t, id: _id, ...input } = frame as unknown as Record<string, unknown>
    connRef.current?.input(input)
  }, [])

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const now = performance.now()
      if (now - lastMoveAt.current < MOVE_MIN_INTERVAL_MS) return
      lastMoveAt.current = now
      const { x, y } = pageCoords(e)
      sendInput({
        t: "in",
        id: windowId,
        k: "move",
        x,
        y,
        b: heldButton(e.buttons),
        cc: 0,
        mods: modsOf(e),
      })
    },
    [pageCoords, sendInput, windowId],
  )
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      canvasRef.current?.focus()
      const { x, y } = pageCoords(e)
      sendInput({
        t: "in",
        id: windowId,
        k: "down",
        x,
        y,
        b: buttonName(e.button),
        cc: Math.max(1, e.detail || 1),
        mods: modsOf(e),
      })
    },
    [pageCoords, sendInput, windowId],
  )
  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = pageCoords(e)
      sendInput({
        t: "in",
        id: windowId,
        k: "up",
        x,
        y,
        b: buttonName(e.button),
        cc: Math.max(1, e.detail || 1),
        mods: modsOf(e),
      })
    },
    [pageCoords, sendInput, windowId],
  )
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const { x, y } = pageCoords(e)
      const { dx, dy } = wheelDeltas(e.nativeEvent, cssRef.current.height)
      sendInput({ t: "in", id: windowId, k: "wheel", x, y, dx, dy, mods: modsOf(e) })
    },
    [pageCoords, sendInput, windowId],
  )
  const onKey = useCallback(
    (type: "down" | "up") => (e: React.KeyboardEvent) => {
      // Cmd/Ctrl+L belongs to the address bar (document handler); everything else to the page.
      if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) return
      // Paste is delivered by the paste handler as text (the remote clipboard is empty).
      if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) return
      e.preventDefault()
      sendInput(keyFrame(windowId, type, e.nativeEvent))
    },
    [sendInput, windowId],
  )
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const text = e.clipboardData?.getData("text")
      if (!text) return
      e.preventDefault()
      sendInput({ t: "in", id: windowId, k: "text", text })
    },
    [sendInput, windowId],
  )
  const onFocus = useCallback(() => connRef.current?.input({ k: "focus" }), [])
  const onBlur = useCallback(() => connRef.current?.input({ k: "blur" }), [])

  const { inputStyle, newTabInputStyle } = useBrowserInputStyles()

  // ── Fallback: no cloud browser on this server (or not on web) ─────────────
  if (status === "unavailable") return <DesktopOnly />
  if (status === "no-app") return <BrowserOff />

  // ── New-tab page: no URL yet (DBAB-REQ-10/14) ─────────────────────────────
  if (!hasContent) {
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
            {status === "live" || status === "connecting"
              ? "Search or enter a URL to open it in this window"
              : "Reconnecting to the browser…"}
          </T>
        </View>
        <View style={{ width: "100%", maxWidth: 640, gap: 8 }}>
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
        {/* The frame box must exist for the first size report; it is invisible here. */}
        <View
          ref={frameBoxRef}
          style={{ position: "absolute", left: 0, right: 0, top: 44, bottom: 0, opacity: 0 }}
          pointerEvents="none"
        />
      </View>
    )
  }

  // ── Toolbar + canvas ──────────────────────────────────────────────────────
  const banner =
    status === "closed"
      ? `The tab was closed (${lastError ?? "unknown"}). Reload to open it again.`
      : status === "offline"
        ? "Reconnecting to the browser…"
        : status === "connecting"
          ? "Connecting to the browser…"
          : null

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
          disabled={!tab?.canGoBack}
          testID="nbw-back"
        />
        <ToolBtn
          icon="arrow-right"
          label="Forward"
          onPress={goForward}
          disabled={!tab?.canGoForward}
          testID="nbw-forward"
        />
        {tab?.loading ? (
          <ToolBtn icon="x" label="Stop" onPress={stop} testID="nbw-stop" />
        ) : (
          <ToolBtn icon="arrow-clockwise" label="Reload" onPress={reload} testID="nbw-reload" />
        )}
        <UrlField
          ref={urlFieldRef}
          testID="nbw-url"
          liveUrl={pendingUrl ?? tab?.url ?? ""}
          onSubmit={submit}
          onDraftChange={setDraft}
          rows={rows}
          highlight={highlight}
          onMoveHighlight={moveHighlight}
          style={inputStyle}
        />
        <ConsentToggle consent={consent} onToggle={toggleConsent} />
      </View>

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

      {banner ? (
        <View
          testID="cbw-banner"
          style={{
            paddingHorizontal: 12,
            paddingVertical: 4,
            backgroundColor: c.bgStep,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <T step="codenote" tone="text3">
            {banner}
          </T>
        </View>
      ) : null}

      {/*
       * The frame box reserves the rectangle (its size is what the backend
       * sizes the real window to); the canvas inside paints the frames at
       * their device-pixel size, scaled by CSS to fill the box.
       */}
      <View
        ref={frameBoxRef}
        testID="cbw-frame-box"
        style={{ flex: 1, backgroundColor: c.bgInner, overflow: "hidden" }}
      >
        {Platform.OS === "web" ? (
          <canvas
            ref={canvasRef}
            data-testid="cbw-canvas"
            tabIndex={0}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
            onKeyDown={onKey("down")}
            onKeyUp={onKey("up")}
            onPaste={onPaste}
            onFocus={onFocus}
            onBlur={onBlur}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              outline: "none",
              cursor: "default",
            }}
          />
        ) : null}
      </View>
    </View>
  )
}
