import { Check, Copy, ExternalLink, FileCode, Maximize2, Minimize2 } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
// @ts-ignore - react-dom types not available but package is present
import { createPortal } from 'react-dom';
import { Platform, useWindowDimensions } from 'react-native';
import WebView from 'react-native-webview';
import { Button, Text, XStack, YStack } from 'tamagui';
import { useAuthStore } from '../../../store/authStore';
import { useTilingStore } from '../../../store/tilingStore';
import { SelectableText } from './shared';

/**
 * Shared floating toolbar for HtmlBubble and HtmlFileBubble.
 * Renders the action buttons (copy/extra + fullscreen) in the top-right corner
 * of the iframe container. Positioned absolute — the parent must be relative.
 */
export function HtmlBubbleToolbar({
  onFullscreen,
  extraButton,
}: {
  onFullscreen: () => void;
  /** Optional button rendered to the left of the fullscreen button (e.g. Copy HTML or Open in FileViewer) */
  extraButton?: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        display: 'flex',
        gap: 6,
      }}
    >
      {extraButton}
      {/* Fullscreen button */}
      <button
        onClick={onFullscreen}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          opacity: 0.7,
          transition: 'opacity 0.2s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
        title="Fullscreen"
      >
        <Maximize2 size={16} color="white" />
      </button>
    </div>
  );
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
  html: string;
  caption?: string;
  height?: number;
  timestamp: Date;
  showTimestamp?: boolean;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(height || 300);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const maxWidth = Math.min(screenWidth * 0.85, 700);

  // Copy HTML to clipboard
  const handleCopyHtml = async () => {
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(html);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (error) {
      console.error('[HtmlBubble] Failed to copy HTML:', error);
    }
  };
  const displayHeight = height || Math.min(iframeHeight, 500);

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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #e0e0e0;
      background: #0f0f17;
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
      background: rgba(255, 255, 255, 0.05);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.25);
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
</html>`;
  }, [html]);

  // Listen for resize messages from iframe
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'resize' && typeof event.data.height === 'number') {
        if (!height) {
          setIframeHeight(event.data.height + 4);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [height]);

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    if (Platform.OS !== 'web' || !isFullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  if (Platform.OS !== 'web') {
    // Native: use WebView with scroll enabled
    return (
      <YStack maxWidth="85%" gap="$2" alignSelf="flex-start">
        <YStack
          width={maxWidth}
          borderRadius="$4"
          overflow="hidden"
          backgroundColor="#0f0f17"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.3)"
        >
          <WebView
            source={{ html: fullHtml }}
            style={{
              width: maxWidth,
              height: displayHeight,
              backgroundColor: '#0f0f17',
            }}
            scrollEnabled={true}
            onMessage={(event) => {
              try {
                const data = JSON.parse(event.nativeEvent.data);
                if (data.type === 'resize' && !height) {
                  setIframeHeight(data.height + 4);
                }
              } catch (e) {}
            }}
          />
        </YStack>

        {caption && (
          <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {showTimestamp && (
          <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
            {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    );
  }

  // Fullscreen overlay component - rendered via portal
  const fullscreenOverlay = isFullscreen
    ? createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.95)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              backgroundColor: 'rgba(20, 20, 30, 0.98)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: 14, fontWeight: 500 }}>
              {caption || 'HTML Widget'}
            </span>
            <button
              onClick={() => setIsFullscreen(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: 8,
                color: 'white',
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              <Minimize2 size={16} color="white" />
              Exit Fullscreen (ESC)
            </button>
          </div>

          {/* Iframe container with scroll */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              backgroundColor: '#0f0f17',
              margin: 20,
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            }}
          >
            <iframe
              srcDoc={fullHtml}
              sandbox="allow-scripts"
              style={{
                width: '100%',
                height: '100%',
                minHeight: screenHeight - 120,
                border: 'none',
                display: 'block',
                backgroundColor: '#0f0f17',
              }}
              title="HTML Widget Fullscreen"
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  // Web: use sandboxed iframe with scroll and fullscreen button
  return (
    <>
      {/* Fullscreen overlay via portal */}
      {fullscreenOverlay}

      <YStack maxWidth="85%" gap="$2" alignSelf="flex-start">
        <YStack
          width={maxWidth}
          borderRadius="$4"
          overflow="hidden"
          backgroundColor="#0f0f17"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.3)"
          position="relative"
        >
          {/* Action buttons */}
          <HtmlBubbleToolbar
            onFullscreen={() => setIsFullscreen(true)}
            extraButton={
              <button
                onClick={handleCopyHtml}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  backgroundColor: copied ? 'rgba(34, 197, 94, 0.8)' : 'rgba(0, 0, 0, 0.6)',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  opacity: 0.7,
                  transition: 'opacity 0.2s, background-color 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                title={copied ? 'Copied!' : 'Copy HTML'}
              >
                {copied ? <Check size={16} color="white" /> : <Copy size={16} color="white" />}
              </button>
            }
          />

          {/* Scrollable iframe container */}
          <div
            style={{
              width: '100%',
              height: displayHeight,
              overflow: 'auto',
              backgroundColor: '#0f0f17',
            }}
          >
            <iframe
              ref={iframeRef}
              srcDoc={fullHtml}
              sandbox="allow-scripts"
              style={{
                width: '100%',
                height: '100%',
                minHeight: displayHeight,
                border: 'none',
                display: 'block',
                backgroundColor: '#0f0f17',
              }}
              title="HTML Widget"
            />
          </div>
        </YStack>

        {caption && (
          <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {showTimestamp && (
          <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
            {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    </>
  );
}

/**
 * HTML File bubble — fetches an HTML file from the workspace and renders it
 * inline (like HtmlBubble) with a file-info strip at the top and an
 * "Abrir en FileViewer" button that opens a new window.
 */
export function HtmlFileBubble({
  filePath,
  caption,
  channelId,
  timestamp,
  showTimestamp = true,
}: {
  filePath: string;
  caption?: string;
  channelId?: string;
  timestamp: Date;
  showTimestamp?: boolean;
}) {
  const openWindow = useTilingStore((s) => s.openWindow);
  const sessionToken = useAuthStore((s) => s.sessionToken);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const filename = filePath.split('/').pop() ?? filePath;
  const maxWidth = Math.min(screenWidth * 0.85, 700);

  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [iframeHeight, setIframeHeight] = useState(300);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fetch file content from backend
  useEffect(() => {
    if (!channelId || !sessionToken) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL ?? '';
    const url = `${backendUrl}/api/files?path=${encodeURIComponent(filePath)}&channelId=${encodeURIComponent(channelId)}`;
    fetch(url, { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => setHtmlContent(text))
      .catch((err) => {
        console.error('[HtmlFileBubble] Failed to fetch file:', err);
        setFetchError(err.message ?? 'Error al cargar el fichero');
      });
  }, [filePath, channelId, sessionToken]);

  // Build a complete sandboxed HTML document — same as HtmlBubble
  const fullHtml = useMemo(() => {
    if (!htmlContent) return '';
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; line-height: 1.5; color: #e0e0e0;
      background: #0f0f17; overflow: auto; min-height: 100%;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
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
</html>`;
  }, [htmlContent]);

  // Auto-resize listener (web)
  useEffect(() => {
    if (Platform.OS !== 'web' || !htmlContent) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'resize' && typeof e.data.height === 'number') {
        setIframeHeight(Math.min(e.data.height + 4, 500));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [htmlContent]);

  // ESC key to exit fullscreen (web)
  useEffect(() => {
    if (Platform.OS !== 'web' || !isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Always open in a new tiling window; _ts prevents same-props dedup
  const handleOpenViewer = () => {
    if (!channelId) return;
    openWindow('file-viewer', { filePath, channelId, _ts: Date.now() }, true);
  };

  // ─── Native path ────────────────────────────────────────────────────────────
  if (Platform.OS !== 'web') {
    return (
      <YStack maxWidth="85%" gap="$2" alignSelf="flex-start" width={maxWidth}>
        <YStack
          width="100%"
          borderRadius="$4"
          overflow="hidden"
          backgroundColor="#0f0f17"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.3)"
        >
          {/* File info strip */}
          <XStack
            padding="$2"
            backgroundColor="rgba(255, 255, 255, 0.04)"
            borderBottomWidth={1}
            borderBottomColor="rgba(255, 255, 255, 0.07)"
            alignItems="center"
            gap="$2"
          >
            <FileCode size={16} color="rgba(255, 255, 255, 0.7)" />
            <YStack flex={1} gap="$0.5" overflow="hidden">
              <Text color="rgba(255, 255, 255, 0.75)" fontSize="$3" fontWeight="500" numberOfLines={1}>
                {filename}
              </Text>
              <Text color="rgba(255, 255, 255, 0.3)" fontSize="$1" fontFamily="monospace" numberOfLines={1}>
                {filePath}
              </Text>
            </YStack>
            {channelId && (
              <Button
                size="$2"
                chromeless
                onPress={handleOpenViewer}
                pressStyle={{ opacity: 0.7 }}
                icon={<ExternalLink size={14} color="rgba(255,255,255,0.6)" />}
              />
            )}
          </XStack>

          {/* Content area */}
          {fetchError ? (
            <XStack padding="$3" alignItems="center" gap="$2">
              <Text color="rgba(239,68,68,0.8)" fontSize="$2">⚠ {fetchError}</Text>
            </XStack>
          ) : !htmlContent ? (
            <XStack padding="$3" alignItems="center" justifyContent="center">
              <Text color="rgba(255,255,255,0.3)" fontSize="$2">Cargando…</Text>
            </XStack>
          ) : (
            <WebView
              source={{ html: fullHtml }}
              style={{ width: maxWidth, height: iframeHeight, backgroundColor: '#0f0f17' }}
              scrollEnabled={true}
              onMessage={(event) => {
                try {
                  const data = JSON.parse(event.nativeEvent.data);
                  if (data.type === 'resize') setIframeHeight(Math.min(data.height + 4, 500));
                } catch {}
              }}
            />
          )}
        </YStack>

        {caption && (
          <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}
        {showTimestamp && (
          <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
            {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    );
  }

  // ─── Fullscreen overlay (web) — same structure as HtmlBubble ────────────────
  const fullscreenOverlay = isFullscreen
    ? createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.95)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              backgroundColor: 'rgba(20, 20, 30, 0.98)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileCode size={16} color="rgba(255, 255, 255, 0.7)" />
              <span style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: 14, fontWeight: 500 }}>
                {filename}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {channelId && (
                <button
                  onClick={handleOpenViewer}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 16px',
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: 8,
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontFamily: 'inherit',
                  }}
                >
                  <ExternalLink size={16} color="white" />
                  Abrir en FileViewer
                </button>
              )}
              <button
                onClick={() => setIsFullscreen(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 16px',
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: 8,
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                <Minimize2 size={16} color="white" />
                Exit Fullscreen (ESC)
              </button>
            </div>
          </div>

          {/* Iframe container with scroll */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              backgroundColor: '#0f0f17',
              margin: 20,
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            }}
          >
            <iframe
              srcDoc={fullHtml}
              sandbox="allow-scripts"
              style={{
                width: '100%',
                height: '100%',
                minHeight: screenHeight - 120,
                border: 'none',
                display: 'block',
                backgroundColor: '#0f0f17',
              }}
              title={`HTML File Fullscreen: ${filename}`}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  // ─── Web path — same structure as HtmlBubble + file info strip ───────────────
  return (
    <>
      {fullscreenOverlay}

      <YStack maxWidth="85%" gap="$2" alignSelf="flex-start">
        <YStack
          width={maxWidth}
          borderRadius="$4"
          overflow="hidden"
          backgroundColor="#0f0f17"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.3)"
          position="relative"
        >
          {/* File info strip — sits above the iframe, below the floating toolbar */}
          <XStack
            padding="$2"
            paddingRight={80}
            backgroundColor="rgba(255, 255, 255, 0.04)"
            borderBottomWidth={1}
            borderBottomColor="rgba(255, 255, 255, 0.07)"
            alignItems="center"
            gap="$2"
            overflow="hidden"
          >
            <FileCode size={16} color="rgba(255, 255, 255, 0.7)" />
            <YStack flex={1} gap="$0.5" overflow="hidden">
              <Text color="rgba(255, 255, 255, 0.75)" fontSize="$3" fontWeight="500" numberOfLines={1}>
                {filename}
              </Text>
              <Text color="rgba(255, 255, 255, 0.3)" fontSize="$1" fontFamily="monospace" numberOfLines={1}>
                {filePath}
              </Text>
            </YStack>
          </XStack>

          {/* Floating action buttons — identical to HtmlBubble, ExternalLink instead of Copy */}
          <HtmlBubbleToolbar
            onFullscreen={() => setIsFullscreen(true)}
            extraButton={
              channelId ? (
                <button
                  onClick={handleOpenViewer}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    backgroundColor: 'rgba(0, 0, 0, 0.6)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    opacity: 0.7,
                    transition: 'opacity 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                  title="Abrir en FileViewer"
                >
                  <ExternalLink size={16} color="white" />
                </button>
              ) : undefined
            }
          />

          {/* Content area — identical to HtmlBubble */}
          {fetchError ? (
            <XStack padding="$3" backgroundColor="rgba(239,68,68,0.06)" alignItems="center" gap="$2">
              <Text color="rgba(239,68,68,0.8)" fontSize="$2">
                ⚠ No se pudo cargar el fichero: {fetchError}
              </Text>
            </XStack>
          ) : !htmlContent ? (
            <XStack
              padding="$3"
              alignItems="center"
              justifyContent="center"
              backgroundColor="rgba(255,255,255,0.02)"
            >
              <Text color="rgba(255,255,255,0.3)" fontSize="$2">
                Cargando…
              </Text>
            </XStack>
          ) : (
            <div
              style={{
                width: '100%',
                height: iframeHeight,
                overflow: 'auto',
                backgroundColor: '#0f0f17',
              }}
            >
              <iframe
                srcDoc={fullHtml}
                sandbox="allow-scripts"
                style={{
                  width: '100%',
                  height: '100%',
                  minHeight: iframeHeight,
                  border: 'none',
                  display: 'block',
                  backgroundColor: '#0f0f17',
                }}
                title={`HTML File: ${filename}`}
              />
            </div>
          )}
        </YStack>

        {caption && (
          <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}
        {showTimestamp && (
          <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
            {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    </>
  );
}
