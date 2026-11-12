/**
 * FileViewerWindow — the FVU universal host (spec v1.2.0).
 *
 * Previously "the HTML file viewer": now a common toolbar (connection dot,
 * mono path, "updated Ns ago" ticker, and the FULL action set icon-only in
 * mirror of the chat widget — Descargar · Pantalla completa · Compartir ·
 * Refrescar (spec v1.3.0; "Abrir en FileViewer" is omitted because you are
 * already here and its slot is taken by Refresh) — and a body delegated to
 * the single render table (FileTypeBody), same one the chat bubble uses.
 *
 * "Pantalla completa" is HYBRID by host (override of OQ3 by Pablo,
 * 2026-10-17 — see ux.md changelog v1.3.0):
 *   - Floating window (lives in `workspaceStore.windows`) → maximize/restore
 *     this very window (the window IS the viewer — the title bar already has
 *     its own maximize).
 *   - Tiling tab (opened from the chat via `tilingStore.openWindow`, the
 *     common case) → SYSTEM fullscreen (`requestFullscreen` on the window's
 *     root container, with `webkitRequestFullscreen` fallback for Safari).
 *     ESC is handled natively by the browser; `fullscreenchange` keeps the
 *     button state in sync. The previous iteration opened the in-app FVU
 *     overlay here — Pablo overrode that: the overlay doesn't use the full
 *     width (maxWidth 900) and its height was broken (body without `fill`
 *     falls back to 400px). The chat bubble still uses the overlay, pending
 *     Pablo's call on whether it also migrates.
 *
 * The body fills the window all the way down (flex 1, no maxHeight caps in
 * the window context).
 *
 * Auto-refresh (FVU-REQ-4, MD↔HTML parity): `client.fileWatcher.watch()` on
 * mount → backend pushes `file_changed` on every save → body updates silently
 * for ANY watchable text kind (MD, CSV, JSON, TXT, HTML). Binaries (image,
 * pdf, audio, video) are fetched by URL and reload on window reopen/refresh.
 * On unmount → `unwatch`. On WS reconnect → re-watch (existing pattern).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Platform, ScrollView, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { FileViewerWindowProps } from "./definition"
import { FullscreenLoader } from "../../components/ui"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import { Dot, T } from "../../components/ui/ds"
import { FileTypeBody } from "../../components/chat/bubbles/FileTypeBody"
import { UniversalFileActions } from "../../components/chat/bubbles/UniversalFileActions"
import { getRenderKind, WATCHABLE_KINDS } from "../../components/chat/bubbles/fileRenderers"
import { backendUrl as resolveBackendUrl } from "../../config/runtime"

interface Props extends FileViewerWindowProps {
  windowId: string
}

/** Format elapsed seconds as a human-readable string */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function FileViewerWindowContent({ windowId, filePath, channelId, workspaceId }: Props) {
  const c = useColors()
  const [textContent, setTextContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // When the file content was last received from the backend
  const [lastReceived, setLastReceived] = useState<Date | null>(null)

  // Ticker: current time, refreshed every second so relative times update live
  const [now, setNow] = useState<Date>(() => new Date())

  // Whether the WebSocket is connected
  const [connected, setConnected] = useState<boolean>(false)

  const [updateKey, setUpdateKey] = useState(0)
  const listenerRef = useRef<((msg: any) => void) | null>(null)

  // v1.3.0 + override OQ3 (Pablo, 2026-10-17): "Pantalla completa" is
  // HYBRID by host.
  //   - Floating window (workspaceStore.windows[windowId] exists) → toggle
  //     maximize/restore on THIS window (the title bar already has its own).
  //   - Tiling tab (the chat path, `tilingStore.openWindow`) → SYSTEM
  //     fullscreen on the window's root container. ESC is handled natively
  //     by the browser; the `fullscreenchange` listener below keeps the
  //     button state in sync. The floating store has no entry for tiling
  //     tabs, so calling maximizeWindow there was a silent no-op
  //     (`if (!win) return state`) and the button appeared dead.
  const isFloating = useWorkspaceStore((s) => Boolean(s.windows[windowId]))
  const isMaximized = useWorkspaceStore(
    (s) => s.windows[windowId]?.isMaximized ?? false,
  )
  const maximizeWindow = useWorkspaceStore((s) => s.maximizeWindow)
  const restoreWindow = useWorkspaceStore((s) => s.restoreWindow)

  // Ref to the root container (web: the outer <div> that wraps toolbar +
  // body). System fullscreen targets THIS node so the action row rides
  // along at the top.
  const rootRef = useRef<View>(null)
  const [isSystemFullscreen, setIsSystemFullscreen] = useState(false)

  // Track the browser's fullscreen state (ESC exits natively; sync the
  // button). Listen to both the standard and the webkit-prefixed events.
  useEffect(() => {
    if (Platform.OS !== "web") return
    const onChange = () => {
      const el =
        document.fullscreenElement ??
        (document as unknown as { webkitFullscreenElement?: Element | null })
          .webkitFullscreenElement
      setIsSystemFullscreen(Boolean(el))
    }
    document.addEventListener("fullscreenchange", onChange)
    document.addEventListener("webkitfullscreenchange", onChange)
    return () => {
      document.removeEventListener("fullscreenchange", onChange)
      document.removeEventListener("webkitfullscreenchange", onChange)
    }
  }, [])

  const handleFullscreen = () => {
    if (isFloating) {
      if (isMaximized) restoreWindow(windowId)
      else maximizeWindow(windowId)
      return
    }
    if (Platform.OS !== "web") return
    const node = rootRef.current as unknown as HTMLElement | null
    if (!node) return
    const doc = document as unknown as {
      fullscreenElement?: Element | null
      webkitFullscreenElement?: Element | null
      exitFullscreen?: () => Promise<void>
      webkitExitFullscreen?: () => void
    }
    const activeEl = doc.fullscreenElement ?? doc.webkitFullscreenElement
    if (activeEl) {
      if (doc.exitFullscreen) doc.exitFullscreen()
      else doc.webkitExitFullscreen?.()
      return
    }
    const el = node as HTMLElement & {
      requestFullscreen?: () => Promise<void>
      webkitRequestFullscreen?: () => void
    }
    if (el.requestFullscreen) el.requestFullscreen()
    else el.webkitRequestFullscreen?.()
  }

  // Blob URL for binary kinds (image/pdf/audio/video): fetched with the
  // session token from /api/files and object-URL'd so <img>/<iframe>/<video>
  // can render it. Refresh remounts the body and re-fetches.
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null)

  const client = getTerosClient()

  const filename = useMemo(() => filePath.split("/").pop() ?? filePath, [filePath])
  const kind = useMemo(() => getRenderKind(filename), [filename])
  const watchable = WATCHABLE_KINDS.has(kind)

  // ── Tick every second ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Track WebSocket connection state ────────────────────────────────────────
  useEffect(() => {
    if (!client) return

    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)

    // Set initial state
    setConnected(client.isConnected?.() ?? false)

    client.on("connected", onConnect)
    client.on("disconnected", onDisconnect)
    return () => {
      client.off("connected", onConnect)
      client.off("disconnected", onDisconnect)
    }
  }, [client])

  // ── File watcher (live auto-refresh for text kinds) ─────────────────────────

  // Keep a ref to the latest startWatching to avoid stale closures in effects
  const startWatchingRef = useRef<() => void>(() => {})

  const startWatching = useCallback(() => {
    if (!client || !filePath || (!channelId && !workspaceId)) return

    setError(null)

    // Remove any previous listener before registering a new one
    if (listenerRef.current) {
      client.off("file_changed", listenerRef.current)
      listenerRef.current = null
    }

    const handler = (msg: { filePath: string; content: string; error?: string }) => {
      if (msg.filePath !== filePath) return
      if (msg.error) {
        setError(msg.error)
        return
      }
      setLastReceived(new Date())
      setTextContent(msg.content ?? "")
      setUpdateKey((k) => k + 1)
    }

    listenerRef.current = handler as (...args: unknown[]) => void
    client.on("file_changed", handler as (...args: unknown[]) => void)

    client.fileWatcher.watch(filePath, channelId!, workspaceId!).catch((err) => {
      console.warn("[FileViewerWindow] watchFile error:", err)
      setError(err?.message ?? "Could not watch file")
    })
  }, [client, filePath, channelId, workspaceId])

  // Always keep the ref up to date
  useEffect(() => {
    startWatchingRef.current = startWatching
  }, [startWatching])

  // Start watching on mount and whenever filePath/channelId change.
  // Non-watchable kinds (binaries) skip the watcher — they render by URL.
  useEffect(() => {
    if (watchable) startWatchingRef.current()
    else setTextContent(null)

    return () => {
      if (client && watchable) {
        client.fileWatcher.unwatch(filePath).catch(() => {})
        if (listenerRef.current) {
          client.off("file_changed", listenerRef.current)
          listenerRef.current = null
        }
      }
    }
  }, [filePath, channelId, workspaceId, watchable])

  // Re-start watching whenever the WS reconnects (uses ref to avoid stale closure)
  useEffect(() => {
    if (!connected || !watchable) return
    startWatchingRef.current()
  }, [connected, watchable])

  // ── Binary fetch (image/pdf/audio/video): blob URL via /api/files ────────
  useEffect(() => {
    if (watchable || !filePath || (!channelId && !workspaceId)) return
    let cancelled = false
    let objectUrl: string | null = null
    const sessionToken = (client as any)?.getSessionToken?.()
    // F2: with cookieAuth (web reload) there is no in-memory token — the
    // httpOnly cookie sent with credentials:'include' authenticates instead.
    const cookieAuth = (client as any)?.isCookieAuth?.() ?? false
    if (!sessionToken && !cookieAuth) return
    const backendUrl = resolveBackendUrl()
    const contextParam = workspaceId
      ? `workspaceId=${encodeURIComponent(workspaceId)}`
      : `channelId=${encodeURIComponent(channelId!)}`
    const fetchUrl = `${backendUrl}/api/files?path=${encodeURIComponent(filePath)}&${contextParam}`
    fetch(fetchUrl, { credentials: "include", headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setBinaryUrl(objectUrl)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Could not load file")
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [watchable, filePath, channelId, workspaceId, client, updateKey])

  const handleRefresh = () => {
    setTextContent(null)
    setError(null)
    if (watchable) startWatching()
    else setUpdateKey((k) => k + 1) // binaries: remount the body
  }

  // ── Derived display values ──────────────────────────────────────────────────
  const updatedAgo = lastReceived ? formatElapsed(now.getTime() - lastReceived.getTime()) : null

  // ── Render ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        {/* Error state keeps Descargar + Compartir alive (ux §3.5): the action
            row operates on the snapshot url / volume path, not on the body. */}
        <View style={{ alignItems: "center", gap: 12, marginBottom: 24 }}>
          <T step="lg">
            {/not found|ENOENT/i.test(error) ? "File not available" : "Could not load file"}
          </T>
          <T step="sm" tone="text3">
            {error}
          </T>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <UniversalFileActions
            url="#"
            filePath={filePath}
            channelId={channelId}
            workspaceId={workspaceId}
            kind={kind}
            variant="window"
            onFullscreen={handleFullscreen}
            onRefresh={handleRefresh}
            testID="fvw-error-actions"
          />
        </View>
      </View>
    )
  }

  const loading = (watchable && textContent === null) || (!watchable && binaryUrl === null)

  return (
    <View ref={rootRef} style={{ flex: 1, backgroundColor: c.bgSheet }}>
      {/* ── Toolbar (common host chrome) ── */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 48,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: c.bgSheet,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        {/* Connection dot — green = watching, red = disconnected */}
        <View
          style={
            Platform.OS === "web" && connected
              ? ({ animation: "pulse 2s infinite" } as any) // web-only style
              : undefined
          }
          accessibilityLabel={connected ? "connected" : "disconnected"}
        >
          <Dot color={connected ? semanticColors.green : semanticColors.red} size={7} />
        </View>

        {/* File path */}
        <T step="code" tone="text2" ellipsis style={{ flex: 1 }}>
          {filePath}
        </T>

        {/* Timing info */}
        {updatedAgo && (
          <T step="codenote" tone="text3">
            Updated {updatedAgo} ago
          </T>
        )}

        {/* v1.3.0 — the FULL set, icon-only, in mirror of the chat widget:
            Descargar · Pantalla completa · Compartir · Refrescar. The
            FileViewer button is omitted (you are already there) and its slot
            is taken by Refresh (ux.md §3.3). "Pantalla completa" is hybrid:
            maximize/restore when floating, SYSTEM fullscreen when tiling
            (override of OQ3 by Pablo, 2026-10-17). */}
        <UniversalFileActions
          url={textContent ? `data:${kind};charset=utf-8,${encodeURIComponent(textContent)}` : "#"}
          filePath={filePath}
          channelId={channelId}
          workspaceId={workspaceId}
          kind={kind}
          variant="window"
          onFullscreen={handleFullscreen}
          onRefresh={handleRefresh}
          testID="fvw-actions"
        />
      </View>

      {/* ── Body — delegated to the single render table ── */}
      {loading ? (
        <FullscreenLoader variant="default" />
      ) : (
        <ScrollView
          key={updateKey}
          style={{ flex: 1, backgroundColor: c.bgSheet }}
          contentContainerStyle={{ flexGrow: 1 }}
        >
          {/* fill: the body reaches the very bottom of the window (v1.3.0) —
              no maxHeight caps in the window context, the ScrollView scrolls. */}
          <FileTypeBody
            kind={kind}
            filename={filename}
            url={binaryUrl ?? "#"}
            textContent={textContent}
            size={undefined}
            fill
            testID="fvw-body"
          />
        </ScrollView>
      )}
    </View>
  )
}
