import { Ph } from "../../ui/ds"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
// @ts-ignore - react-dom types not available but package is present
import { createPortal } from "react-dom"
import { Platform, useWindowDimensions } from "react-native"
import WebView from "react-native-webview"
import { Button, Text, XStack, YStack } from "tamagui"
import { useColors, useMcaTheme } from "../../mca/primitives/useColors"
import { colors as semanticColors } from "../../mca/primitives/colors"
import i18n from "../../../i18n"
import { useAuthStore } from "../../../store/authStore"
import { useTilingStore } from "../../../store/tilingStore"
import { SelectableText } from "./shared"
import { UniversalFileActions } from "./UniversalFileActions"
import { backendUrl as resolveBackendUrl } from "../../../config/runtime"

/**
 * Shared floating toolbar for HtmlBubble and HtmlFileBubble.
 * Renders the action buttons (copy/extra + fullscreen) in the top-right corner
 * of the iframe container. Positioned absolute — the parent must be relative.
 */
export function HtmlBubbleToolbar({
  onFullscreen,
  extraButton,
  fullscreenLabel,
}: {
  onFullscreen: () => void
  extraButton?: React.ReactNode
  fullscreenLabel?: string
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 10,
        display: "flex",
        gap: 6,
      }}
    >
      {extraButton}
      <button
        onClick={onFullscreen}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          backgroundColor: "rgba(0, 0, 0, 0.6)",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          opacity: 0.7,
          transition: "opacity 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
        title={fullscreenLabel ?? "Fullscreen"}
      >
        <Ph name="arrows-out-simple" size={16} color="white" />
      </button>
    </div>
  )
}

/**
 * HTML Widget bubble - renders HTML/CSS content in a sandboxed iframe
 * Used for UI mockups, diagrams, styled content, etc.
 * Features: horizontal/vertical scroll, fullscreen mode
 */
export function HtmlBubble({
  html,
  caption,
  height,
  timestamp,
  showTimestamp = true,
}: {
  html: string
  caption?: string
  height?: number
  timestamp: Date
  showTimestamp?: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useMcaTheme() === "dark"
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState(height || 300)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [copied, setCopied] = useState(false)

  // v1.3.3 mobile fix (Bug 2, Pablo 2026-10-16): symmetric L=R margins.
  // On narrow screens the bubble fills 100% of the available width (the
  // chat padding provides the equal margins); the 85%/700px cap only
  // applies on wide screens where the leftover doesn't read as a lopsided
  // right-only gap.
  const isNarrow = screenWidth < 640
  const maxWidth: number | "100%" = isNarrow ? "100%" : Math.min(screenWidth * 0.85, 700)

  // Copy HTML to clipboard
  const handleCopyHtml = async () => {
    try {
      if (Platform.OS === "web") {
        await navigator.clipboard.writeText(html)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch (error) {
      console.error("[HtmlBubble] Failed to copy HTML:", error)
    }
  }
  const displayHeight = height || Math.min(iframeHeight, 500)

  // Create a complete HTML document with styles - enable scrolling
  const fullHtml = useMemo(() => {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      font-family: 'Saans', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: ${isDark ? "#e0e0e0" : "#1A1A1F"};
      background: ${c.bgStep};
      overflow: auto;
      min-height: 100%;
    }
    body {
      padding: 0;
    }
    /* Custom scrollbar for webkit browsers */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: ${isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(10, 10, 15, 0.05)"};
    }
    ::-webkit-scrollbar-thumb {
      background: ${isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(10, 10, 15, 0.15)"};
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: ${isDark ? "rgba(255, 255, 255, 0.25)" : "rgba(10, 10, 15, 0.25)"};
    }
  </style>
</head>
<body>
${html}
<script>
  // Auto-resize: send dimensions to parent
  function sendDimensions() {
    const height = document.body.scrollHeight;
    const width = document.body.scrollWidth;
    window.parent.postMessage({ type: 'resize', height, width }, '*');
  }
  // Send on load and after images load
  window.addEventListener('load', sendDimensions);
  document.querySelectorAll('img').forEach(img => {
    img.addEventListener('load', sendDimensions);
  });
  // Initial send
  setTimeout(sendDimensions, 100);
  // Also on resize
  window.addEventListener('resize', sendDimensions);
</script>
</body>
</html>`
  }, [html, isDark])

  // Listen for resize messages from iframe
  useEffect(() => {
    if (Platform.OS !== "web") return

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "resize" && typeof event.data.height === "number") {
        if (!height) {
          setIframeHeight(event.data.height + 4)
        }
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [height])

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    if (Platform.OS !== "web" || !isFullscreen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isFullscreen])

  if (Platform.OS !== "web") {
    // Native: use WebView with scroll enabled
    return (
      <YStack maxWidth={maxWidth} width="100%" minWidth={0} gap="$2" alignSelf="flex-start">
        <YStack
          width="100%"
          minWidth={0}
          borderRadius={16}
          overflow="hidden"
          backgroundColor={c.bgStep}
          borderWidth={1}
          borderColor={c.border}
        >
          <WebView
            source={{ html: fullHtml }}
            style={{
              width: "100%",
              height: displayHeight,
              backgroundColor: c.bgStep,
            }}
            scrollEnabled={true}
            onMessage={(event) => {
              try {
                const data = JSON.parse(event.nativeEvent.data)
                if (data.type === "resize" && !height) {
                  setIframeHeight(data.height + 4)
                }
              } catch (err) {
                // Malformed iframe messages are ignored, but never silently.
                console.debug("[HtmlBubble] ignoring malformed iframe message:", err)
              }
            }}
          />
        </YStack>

        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {showTimestamp && (
          <SelectableText fontSize="$2" color={c.text3} selectable>
            {timestamp.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
          </SelectableText>
        )}
      </YStack>
    )
  }

  // Fullscreen overlay component - rendered via portal
  const fullscreenOverlay = isFullscreen
    ? createPortal(
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: isDark ? "rgba(32, 28, 39, 0.96)" : "rgba(250, 249, 252, 0.98)",
            zIndex: 99999,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 20px",
              backgroundColor: c.bgStep,
              borderBottom: `1px solid ${isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(10, 10, 15, 0.1)"}`,
              flexShrink: 0,
            }}
          >
            <span style={{ color: c.text2, fontSize: 14, fontWeight: 400 }}>
              {caption || t("conversation.htmlWidget")}
            </span>
            <button
              onClick={() => setIsFullscreen(false)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                backgroundColor: c.wash2,
                border: `1px solid ${isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(10, 10, 15, 0.15)"}`,
                borderRadius: 8,
                color: c.text,
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "inherit",
              }}
            >
              <Ph name="arrows-in-simple" size={16} color={c.text} />
              {t("conversation.exitFullscreen")}
            </button>
          </div>

          {/* Iframe container with scroll */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              backgroundColor: c.bgStep,
              margin: 20,
              borderRadius: 12,
              boxShadow: isDark
                ? "0 8px 32px rgba(0, 0, 0, 0.5)"
                : "0 4px 20px rgba(10, 10, 15, 0.14)",
            }}
          >
            <iframe
              srcDoc={fullHtml}
              sandbox="allow-scripts"
              style={{
                width: "100%",
                height: "100%",
                minHeight: screenHeight - 120,
                border: "none",
                display: "block",
                backgroundColor: c.bgStep,
              }}
              title="HTML Widget Fullscreen"
            />
          </div>
        </div>,
        document.body,
      )
    : null

  // Web: use sandboxed iframe with scroll and fullscreen button
  return (
    <>
      {/* Fullscreen overlay via portal */}
      {fullscreenOverlay}

      <YStack maxWidth={maxWidth} width="100%" minWidth={0} gap="$2" alignSelf="flex-start">
        <YStack
          width="100%"
          minWidth={0}
          borderRadius={16}
          overflow="hidden"
          backgroundColor={c.bgStep}
          borderWidth={1}
          borderColor={c.border}
          position="relative"
        >
          {/* Action buttons */}
          <HtmlBubbleToolbar
            onFullscreen={() => setIsFullscreen(true)}
            fullscreenLabel={t("conversation.fullscreen")}
            extraButton={
              <button
                onClick={handleCopyHtml}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  backgroundColor: copied
                    ? "rgba(34, 197, 94, 0.8)"
                    : isDark
                      ? "rgba(0, 0, 0, 0.6)"
                      : "rgba(10, 10, 15, 0.1)",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  opacity: 0.7,
                  transition: "opacity 0.2s, background-color 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
                title={copied ? t("conversation.copiedHtml") : t("conversation.copyHtml")}
              >
                {copied ? (
                  <Ph name="check" size={16} color={c.text} />
                ) : (
                  <Ph name="copy" size={16} color={c.text} />
                )}
              </button>
            }
          />

          {/* Scrollable iframe container */}
          <div
            style={{
              width: "100%",
              height: displayHeight,
              overflow: "auto",
              backgroundColor: c.bgStep,
            }}
          >
            <iframe
              ref={iframeRef}
              srcDoc={fullHtml}
              sandbox="allow-scripts"
              style={{
                width: "100%",
                height: "100%",
                minHeight: displayHeight,
                border: "none",
                display: "block",
                backgroundColor: c.bgStep,
              }}
              title="HTML Widget"
            />
          </div>
        </YStack>

        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {showTimestamp && (
          <SelectableText fontSize="$2" color={c.text3} selectable>
            {timestamp.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
          </SelectableText>
        )}
      </YStack>
    </>
  )
}

/**
 * HTML File bubble — fetches an HTML file from the workspace and renders it
 * inline (like HtmlBubble) with a file-info strip at the top and an
 * "Abrir en FileViewer" button that opens a new window.
 */
export function HtmlFileBubble({
  filePath,
  caption,
  workspaceId,
  channelId,
  timestamp,
  showTimestamp = true,
}: {
  filePath: string
  caption?: string
  workspaceId?: string
  channelId?: string
  timestamp: Date
  showTimestamp?: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useMcaTheme() === "dark"
  const openWindow = useTilingStore((s: any) => s.openWindow)
  const sessionToken = useAuthStore((s: any) => s.sessionToken)
  const cookieAuth = useAuthStore((s: any) => s.cookieAuth)
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()

  const filename = filePath.split("/").pop() ?? filePath
  // v1.3.3 mobile fix (Bug 2, Pablo 2026-10-16): symmetric L=R margins —
  // fill 100% of the available width on narrow screens; cap only on wide.
  const isNarrow = screenWidth < 640
  const maxWidth: number | "100%" = isNarrow ? "100%" : Math.min(screenWidth * 0.85, 700)

  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [iframeHeight, setIframeHeight] = useState(300)


  // Fetch file content from backend
  useEffect(() => {
    // F2: cookieAuth (web reload) has no in-memory token — the httpOnly
    // cookie sent with credentials:'include' authenticates the fetch.
    if ((!channelId && !workspaceId) || (!sessionToken && !cookieAuth)) return
    const backendUrl = resolveBackendUrl()
    const contextParam = workspaceId
      ? `workspaceId=${encodeURIComponent(workspaceId)}`
      : `channelId=${encodeURIComponent(channelId!)}`
    const url = `${backendUrl}/api/files?path=${encodeURIComponent(filePath)}&${contextParam}`
    fetch(url, { credentials: "include", headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((text) => setHtmlContent(text))
      .catch((err) => {
        console.error("[HtmlFileBubble] Failed to fetch file:", err)
        setFetchError(err.message ?? "unknown")
      })
  }, [filePath, workspaceId, channelId, sessionToken, cookieAuth])

  // Build a complete sandboxed HTML document — same as HtmlBubble
  const fullHtml = useMemo(() => {
    if (!htmlContent) return ""
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      font-family: 'Saans', system-ui, -apple-system, sans-serif;
      font-size: 14px; line-height: 1.5; color: ${isDark ? "#e0e0e0" : "#1A1A1F"};
      background: ${c.bgStep}; overflow: auto; min-height: 100%;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: ${isDark ? "rgba(255,255,255,0.05)" : "rgba(10,10,15,0.05)"}; }
    ::-webkit-scrollbar-thumb { background: ${isDark ? "rgba(255,255,255,0.15)" : "rgba(10,10,15,0.15)"}; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: ${isDark ? "rgba(255,255,255,0.25)" : "rgba(10,10,15,0.25)"}; }
  </style>
</head>
<body>
${htmlContent}
<script>
  function sendDimensions() {
    window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*');
  }
  window.addEventListener('load', sendDimensions);
  document.querySelectorAll('img').forEach(img => img.addEventListener('load', sendDimensions));
  setTimeout(sendDimensions, 100);
  window.addEventListener('resize', sendDimensions);
</script>
</body>
</html>`
  }, [htmlContent, isDark])

  // Auto-resize listener (web)
  useEffect(() => {
    if (Platform.OS !== "web" || !htmlContent) return
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "resize" && typeof e.data.height === "number") {
        setIframeHeight(Math.min(e.data.height + 4, 500))
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [htmlContent])

  // Detect markdown files — these get an extra "Open in Markdown Viewer" button
  const isMarkdownFile = /\.(md|markdown)$/i.test(filePath)

  // Always open in a new tiling window; _ts prevents same-props dedup
  const handleOpenViewer = () => {
    if (!channelId && !workspaceId) return
    // _ts busts dedup so a re-download of the same path re-opens; preview
    // routing (preview-tabs.md) keeps it in the desktop's preview tab instead
    // of piling up tabs. Only ctrl/cmd-click opens a separate tab.
    openWindow("file-viewer", { filePath, channelId, workspaceId, _ts: Date.now() }, false)
  }

  const handleOpenMarkdownViewer = () => {
    if (!channelId && !workspaceId) return
    // Deduplication is handled by the window registry via getKey = filePath
    openWindow("markdown-viewer", { filePath, channelId, workspaceId }, false)
  }

  // ─── Native path ────────────────────────────────────────────────────────────
  if (Platform.OS !== "web") {
    return (
      <YStack maxWidth={maxWidth} width="100%" minWidth={0} gap="$2" alignSelf="flex-start">
        <YStack
          width="100%"
          minWidth={0}
          borderRadius={16}
          overflow="hidden"
          backgroundColor={c.bgStep}
          borderWidth={1}
          borderColor={c.border}
        >
          {/* File info strip */}
          <XStack
            padding="$2"
            backgroundColor={c.nest}
            borderBottomWidth={1}
            borderBottomColor={isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(10, 10, 15, 0.07)"}
            alignItems="center"
            gap="$2"
          >
            <Ph name="file-code" size={16} color={c.text2} />
            <YStack flex={1} gap="$0.5" overflow="hidden">
              <Text color={c.text2} fontSize="$3" fontWeight="400" numberOfLines={1}>
                {filename}
              </Text>
              <Text color={c.text3} fontSize="$1" fontFamily="$mono" numberOfLines={1}>
                {filePath}
              </Text>
            </YStack>
            {channelId && isMarkdownFile && (
              <Button
                size="$2"
                chromeless
                onPress={handleOpenMarkdownViewer}
                pressStyle={{ opacity: 0.7 }}
                icon={<Ph name="file-text" size={14} color="rgba(111,39,255,0.8)" />}
              />
            )}
            {channelId && !isMarkdownFile && (
              <Button
                size="$2"
                chromeless
                onPress={handleOpenViewer}
                pressStyle={{ opacity: 0.7 }}
                icon={<Ph name="arrow-square-out" size={14} color={c.text2} />}
              />
            )}
          </XStack>

          {/* Content area */}
          {fetchError ? (
            <XStack padding="$3" alignItems="center" gap="$2">
              <Text color="rgba(239,68,68,0.8)" fontSize="$2">
                ⚠ {t("conversation.couldNotLoadFile", { error: fetchError })}
              </Text>
            </XStack>
          ) : !htmlContent ? (
            <XStack padding="$3" alignItems="center" justifyContent="center">
              <Text color={c.text3} fontSize="$2">
                {t("conversation.loadingFile")}
              </Text>
            </XStack>
          ) : (
            <WebView
              source={{ html: fullHtml }}
              style={{ width: "100%", height: iframeHeight, backgroundColor: c.bgStep }}
              scrollEnabled={true}
              onMessage={(event) => {
                try {
                  const data = JSON.parse(event.nativeEvent.data)
                  if (data.type === "resize") setIframeHeight(Math.min(data.height + 4, 500))
                } catch (err) {
                  console.debug("[HtmlBubble] ignoring malformed iframe message:", err)
                }
              }}
            />
          )}
        </YStack>

        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}
        {showTimestamp && (
          <SelectableText fontSize="$2" color={c.text3} selectable>
            {timestamp.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
          </SelectableText>
        )}
      </YStack>
    )
  }


  // ─── Web path — same structure as HtmlBubble + file info strip ───────────────
  return (
    <>
      <YStack maxWidth={maxWidth} width="100%" minWidth={0} gap="$2" alignSelf="flex-start">
        <YStack
          width="100%"
          minWidth={0}
          borderRadius={16}
          overflow="hidden"
          backgroundColor={c.bgStep}
          borderWidth={1}
          borderColor={c.border}
          position="relative"
        >
          {/* File info strip + FVU action row INSIDE the strip (ux v1.2):
              fixed-height row, no floating overlay, no paddingRight hacks.
              The 4 universal actions + the HTML extra "Copiar" as 5th icon. */}
          <XStack
            padding="$2"
            backgroundColor={c.nest}
            borderBottomWidth={1}
            borderBottomColor={isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(10, 10, 15, 0.07)"}
            alignItems="center"
            gap="$2"
          >
            <Ph name="file-code" size={16} color={c.text2} />
            <YStack flex={1} gap="$0.5" minWidth={0}>
              <Text color={c.text2} fontSize="$3" fontWeight="400" numberOfLines={1}>
                {filename}
              </Text>
              <Text color={c.text3} fontSize="$1" fontFamily="$mono" numberOfLines={1}>
                {filePath}
              </Text>
            </YStack>
            {/* v1.3.0 - the 2 essential actions. Fullscreen/Share/Copiar
                live in the viewer window (the old bubble never had Copiar). */}
            <UniversalFileActions
              url={htmlContent ? `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}` : "#"}
              filePath={filePath}
              channelId={channelId}
              workspaceId={workspaceId}
              kind={isMarkdownFile ? "markdown" : "html"}
              variant="bubble"
              onOpenViewer={isMarkdownFile ? handleOpenMarkdownViewer : handleOpenViewer}
              testID="html-file-bubble-actions"
            />
          </XStack>

          {/* Content area — identical to HtmlBubble */}
          {fetchError ? (
            <XStack
              padding="$3"
              backgroundColor="rgba(239,68,68,0.06)"
              alignItems="center"
              gap="$2"
            >
              <Text color="rgba(239,68,68,0.8)" fontSize="$2">
                ⚠ {t("conversation.couldNotLoadFile", { error: fetchError })}
              </Text>
            </XStack>
          ) : !htmlContent ? (
            <XStack
              padding="$3"
              alignItems="center"
              justifyContent="center"
              backgroundColor={c.nest}
            >
              <Text color={c.text3} fontSize="$2">
                {t("conversation.loadingFile")}
              </Text>
            </XStack>
          ) : (
            <div
              style={{
                width: "100%",
                height: iframeHeight,
                overflow: "auto",
                backgroundColor: c.bgStep,
              }}
            >
              <iframe
                srcDoc={fullHtml}
                sandbox="allow-scripts"
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: iframeHeight,
                  border: "none",
                  display: "block",
                  backgroundColor: c.bgStep,
                }}
                title={`HTML File: ${filename}`}
              />
            </div>
          )}
        </YStack>

        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}
        {showTimestamp && (
          <SelectableText fontSize="$2" color={c.text3} selectable>
            {timestamp.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
          </SelectableText>
        )}
      </YStack>
    </>
  )
}
