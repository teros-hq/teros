/**
 * CodeEditorWindowContent
 *
 * Main component for the Code Editor window.
 * Renders a CodeMirror 6 editor inside a WebView (native) or iframe (web).
 * Vim mode is toggleable and persisted via storage. Communicates via postMessage bridge.
 *
 * Initialization sequence:
 *   1. WebView mounts immediately (always rendered, hidden while loading)
 *   2. Bundle loads → sends { type: 'ready' } → editorReadyRef = true
 *   3. file.watch resolves → fileLoadedRef = true, loadState = 'loaded'
 *   4. Whichever arrives last calls initEditor(content)
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, KeyboardAvoidingView, Platform, View } from "react-native"
import RawWebView from "react-native-webview"
import type { WebViewMessageEvent } from "react-native-webview"
// Cast to accept props on all platforms (RN-web type resolution issue)
const WebView = RawWebView as any
import { getTerosClient } from "../../services/terosClientSingleton"
import { AppSpinner } from "../../components/ui"
import { useTilingStore } from "../../store/tilingStore"
import { useColorScheme } from "react-native"
import { storage, STORAGE_KEYS } from "../../services/storage"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  type BadgeTone,
  Btn,
  ChipBtn,
  EmptyState,
  IconBtn,
  PHead,
  T,
} from "../../components/ui/ds"
import type { CodeEditorWindowProps } from "./definition"
import { detectLanguage } from "./languageDetector"
import { editorHtml } from "./editorBundle"

// ── Constants ─────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props extends CodeEditorWindowProps {
  windowId: string
}

type LoadState = "loading" | "loaded" | "error"
type VimModeState = "normal" | "insert" | "visual" | "visual-line" | "visual-block" | "replace"

const VIM_MODE_LABEL: Record<string, string> = {
  normal: "NOR",
  insert: "INS",
  visual: "VIS",
  "visual-line": "V-L",
  "visual-block": "V-B",
  replace: "REP",
}
// Vim mode → status tint (amber normal · green insert · violet visual · red replace).
const VIM_MODE_TONE: Record<string, BadgeTone> = {
  normal: "a",
  insert: "g",
  visual: "i",
  "visual-line": "i",
  "visual-block": "i",
  replace: "r",
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CodeEditorWindowContent({ windowId, filePath, workspaceId, channelId }: Props) {
  const webViewRef = useRef<any>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const contentRef = useRef<string>("")
  // Both must be true before initEditor() is called
  const editorReadyRef = useRef(false) // bundle sent 'ready'
  const fileLoadedRef = useRef(false) // file content received
  const initCalledRef = useRef(false) // guard: init only once per mount

  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [errorMsg, setErrorMsg] = useState("")
  const [vimModeState, setVimModeState] = useState<VimModeState>("normal")
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  // vim enabled/disabled — loaded from storage, defaults to true
  const [vimEnabled, setVimEnabled] = useState(true)
  const vimEnabledRef = useRef(true) // ref so initEditor closure always reads latest value

  const colorScheme = useColorScheme() ?? "dark"
  const c = useColors()
  const language = detectLanguage(filePath)
  const filename = filePath.split("/").pop() ?? filePath

  const client = getTerosClient()
  const closeWindow = useTilingStore((s) => s.closeWindow)
  const listenerRef = useRef<((msg: any) => void) | null>(null)

  // ── Load vim preference from storage on mount ─────────────────────────────
  useEffect(() => {
    storage.get<string>(STORAGE_KEYS.VIM_MODE).then((val) => {
      // Default is true; only set to false if explicitly stored as 'false'
      const enabled = val !== "false"
      vimEnabledRef.current = enabled
      setVimEnabled(enabled)
    })
  }, [])

  // ── inject JS into WebView or iframe ─────────────────────────────────────
  const injectJS = useCallback((code: string) => {
    if (Platform.OS === "web") {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ __terosInject: code }), "*")
    } else {
      webViewRef.current?.injectJavaScript(code + "; true;")
    }
  }, [])

  // ── initEditor: call only when BOTH ready + file loaded ──────────────────
  const initEditor = useCallback(
    (content: string) => {
      if (initCalledRef.current) return
      initCalledRef.current = true
      const payload = JSON.stringify({
        content,
        language,
        theme: colorScheme,
        vimMode: vimEnabledRef.current,
      })
      injectJS(`window.terosEditor && window.terosEditor.init(${payload})`)
    },
    [language, colorScheme, injectJS],
  )

  // ── maybeInit: call after either ready or file arrives ───────────────────
  const maybeInit = useCallback(() => {
    if (editorReadyRef.current && fileLoadedRef.current) {
      initEditor(contentRef.current)
    }
  }, [initEditor])

  // ── file watcher ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !filePath || (!workspaceId && !channelId)) return

    // Reset state for this file
    setLoadState("loading")
    setErrorMsg("")
    setIsDirty(false)
    fileLoadedRef.current = false
    initCalledRef.current = false
    contentRef.current = ""

    if (listenerRef.current) {
      client.off("file_changed", listenerRef.current)
      listenerRef.current = null
    }

    const handler = (msg: any) => {
      if (msg.filePath !== filePath) return
      if (msg.error) {
        setErrorMsg(msg.error)
        setLoadState("error")
        return
      }
      if (!fileLoadedRef.current) {
        fileLoadedRef.current = true
        contentRef.current = msg.content ?? ""
        setLoadState("loaded")
        maybeInit()
      }
    }

    listenerRef.current = handler
    client.on("file_changed", handler)

    client.fileWatcher.watch(filePath!, channelId!, workspaceId).catch((err: Error) => {
      setErrorMsg(err?.message ?? "Could not load file")
      setLoadState("error")
      if (listenerRef.current) {
        client.off("file_changed", listenerRef.current)
        listenerRef.current = null
      }
    })

    return () => {
      if (listenerRef.current) {
        client.off("file_changed", listenerRef.current)
        listenerRef.current = null
      }
      client.fileWatcher.unwatch(filePath).catch(() => {})
    }
  }, [filePath, workspaceId, channelId])

  // ── save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (isSaving || !client) return
    setIsSaving(true)
    try {
      await client.fileBrowser.write(workspaceId ?? "", filePath, contentRef.current)
      setIsDirty(false)
      setLastSaved(new Date().toLocaleTimeString())
      injectJS("window.terosEditor && window.terosEditor.onSaved()")
    } catch (err: any) {
      const msg = err?.message ?? "Write failed"
      injectJS(`window.terosEditor && window.terosEditor.onSaveError(${JSON.stringify(msg)})`)
    } finally {
      setIsSaving(false)
    }
  }, [isSaving, client, workspaceId, filePath, injectJS])

  const handleSaveAndClose = useCallback(async () => {
    await handleSave()
    closeWindow(windowId)
  }, [handleSave, closeWindow, windowId])

  const { t } = useTranslation()

  const handleClose = useCallback(
    (force: boolean) => {
      if (!force && isDirty) {
        Alert.alert(
          t("errors.editor.unsavedChangesTitle"),
          t("errors.editor.unsavedChangesMessage"),
          [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("errors.editor.closeWithoutSaving"),
              style: "destructive",
              onPress: () => closeWindow(windowId),
            },
          ],
        )
      } else {
        closeWindow(windowId)
      }
    },
    [isDirty, closeWindow, windowId, t],
  )

  // ── vim toggle ────────────────────────────────────────────────────────────
  const handleToggleVim = useCallback(() => {
    const next = !vimEnabledRef.current
    vimEnabledRef.current = next
    setVimEnabled(next)
    // Persist preference
    storage.set(STORAGE_KEYS.VIM_MODE, next ? "true" : "false")
    // Tell the bundle to reconfigure the vim Compartment
    injectJS(`window.terosEditor && window.terosEditor.setVimMode(${next})`)
    // Reset the mode indicator when disabling
    if (!next) setVimModeState("normal")
  }, [injectJS])

  // ── bridge: messages from editor ─────────────────────────────────────────
  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: any
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }
      switch (msg.type) {
        case "ready":
          editorReadyRef.current = true
          maybeInit()
          break
        case "change":
          contentRef.current = msg.content ?? ""
          setIsDirty(true)
          break
        case "save":
          handleSave()
          break
        case "saveAndClose":
          handleSaveAndClose()
          break
        case "close":
          handleClose(msg.force === true)
          break
        case "reload":
          if (client) client.fileWatcher.watch(filePath!, channelId!, workspaceId).catch(() => {})
          break
        case "modeChange":
          setVimModeState((msg.mode as VimModeState) ?? "normal")
          break
        case "blurKeyboard":
          if (Platform.OS !== "web") {
            webViewRef.current?.injectJavaScript("document.activeElement?.blur(); true;")
          }
          break
      }
    },
    [
      maybeInit,
      handleSave,
      handleSaveAndClose,
      handleClose,
      client,
      filePath,
      channelId,
      workspaceId,
    ],
  )

  // ── web: listen to iframe postMessage ────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== "web") return
    const onMsg = (e: MessageEvent) => {
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data
        if (data && data.type) handleMessage({ nativeEvent: { data: JSON.stringify(data) } } as any)
      } catch (err) {
        console.debug("[CodeEditorWindow] ignoring malformed iframe message:", err)
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [handleMessage])

  // ── render ────────────────────────────────────────────────────────────────
  const modeLabel = VIM_MODE_LABEL[vimModeState] ?? "NOR"
  const modeTone = VIM_MODE_TONE[vimModeState] ?? "a"

  const handleRetry = () => {
    setLoadState("loading")
    fileLoadedRef.current = false
    initCalledRef.current = false
    if (client) client.fileWatcher.watch(filePath!, channelId!, workspaceId).catch(() => {})
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "height" : undefined}
    >
      <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
        {/* ── Toolbar ── */}
        <PHead
          icon="code"
          title={
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {isDirty ? (
                <View
                  accessibilityLabel={t("codeEditor.unsaved", { defaultValue: "Sin guardar" })}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: c.tint.a.tx,
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <T step="xl" ellipsis style={{ flexShrink: 1 }}>
                {filename}
              </T>
            </View>
          }
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {lastSaved && !isDirty ? (
                <T step="codenote" tone="text3" style={{ marginRight: 4 }}>
                  saved {lastSaved}
                </T>
              ) : null}

              {/* VIM toggle */}
              <ChipBtn
                mono
                on={vimEnabled}
                onPress={handleToggleVim}
                testID="code-editor-vim-toggle"
              >
                VIM
              </ChipBtn>

              {/* ESC — only on native, only when vim is enabled */}
              {Platform.OS !== "web" && vimEnabled && (
                <ChipBtn
                  mono
                  onPress={() => injectJS("window.terosEditor && window.terosEditor.pressEscape()")}
                >
                  ESC
                </ChipBtn>
              )}

              {/* Save */}
              {isSaving ? (
                <View
                  style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
                >
                  <AppSpinner size="sm" />
                </View>
              ) : (
                <IconBtn
                  icon="floppy-disk"
                  plain
                  sm
                  on={isDirty}
                  title={t("common.save")}
                  onPress={handleSave}
                  disabled={!isDirty}
                  testID="code-editor-save"
                />
              )}
            </View>
          }
        >
          {/* Vim mode indicator — only shown when vim is enabled */}
          {vimEnabled && (
            <Badge tone={modeTone} mono sm>
              {modeLabel}
            </Badge>
          )}
          <T step="code" tone="text3" ellipsis style={{ flexShrink: 1 }}>
            {filePath}
          </T>
        </PHead>

        {/* ── Editor area: the bundle keeps its own editor theme ── */}
        <View style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* ── Loading overlay — shown while file is loading ── */}
          {loadState === "loading" && (
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                backgroundColor: c.bgSheet,
                zIndex: 10,
              }}
            >
              <AppSpinner size="md" />
              <T step="sm" tone="text3">
                Loading {filename}…
              </T>
            </View>
          )}

          {/* ── Error ── */}
          {loadState === "error" && (
            <View style={{ flex: 1, justifyContent: "center" }}>
              <EmptyState
                icon="warning"
                title={errorMsg || "Could not load file."}
                action={
                  <Btn
                    variant="sec"
                    size="sm"
                    icon="arrows-clockwise"
                    onPress={handleRetry}
                    testID="code-editor-retry"
                  >
                    {t("common.retry")}
                  </Btn>
                }
              />
            </View>
          )}

          {/* ── WebView — ALWAYS mounted so 'ready' can be received ── */}
          {loadState !== "error" &&
            (Platform.OS === "web" ? (
              // flex: 1 does not work reliably on <iframe> — use absolute positioning
              // inside a flex-1 wrapper so the iframe fills the remaining space.
              <View style={{ flex: 1, overflow: "hidden", position: "relative" }}>
                <iframe
                  ref={iframeRef as any}
                  srcDoc={editorHtml}
                  style={
                    {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      width: "100%",
                      height: "100%",
                      border: "none",
                      display: "block",
                      visibility: loadState === "loaded" ? "visible" : "hidden",
                    } as any
                  }
                  onLoad={() => {
                    // The bundle itself sends 'ready' via postMessage.
                  }}
                  title={filename}
                />
              </View>
            ) : (
              <WebView
                ref={webViewRef}
                source={{ html: editorHtml }}
                onMessage={handleMessage}
                javaScriptEnabled
                scrollEnabled={false}
                keyboardDisplayRequiresUserAction={false}
                automaticallyAdjustContentInsets={false}
                originWhitelist={["*"]}
                style={{
                  flex: 1,
                  opacity: loadState === "loaded" ? 1 : 0,
                }}
              />
            ))}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}
