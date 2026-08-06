/**
 * FileViewerWindow Content
 *
 * Renders an HTML file in real time. On mount it calls `client.fileWatcher.watch()`
 * which sends a `file.watch` request via WsFramework; the backend resolves the
 * host path, sends the current file content immediately, then pushes `file_changed`
 * events via SubscriptionManager on every subsequent save. On unmount it calls
 * `client.fileWatcher.unwatch()` to stop the watcher.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for status accents (green, red).
 * - Uses Tamagui font tokens (`$body`, `$mono`).
 */

import { RefreshCw } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import WebView from 'react-native-webview';
import { Button, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import type { FileViewerWindowProps } from './definition';
import { AppSpinner, FullscreenLoader, SharePopover } from '../../components/ui';
import { colors as semanticColors } from '../../components/mca/primitives/colors';
import { useColors } from '../../components/mca/primitives/useColors';

interface Props extends FileViewerWindowProps {
  windowId: string;
}

/**
 * Responsive CSS injected into every rendered HTML file so the content
 * adapts to the width of the FileViewer window instead of overflowing.
 * Uses `!important` + high specificity to override author styles that
 * set fixed pixel widths on common layout primitives (tables, containers,
 * images, svgs). Authors can still opt out by setting `max-width: none`.
 */
const RESPONSIVE_CSS = `
  html, body {
    max-width: 100% !important;
    overflow-x: auto !important;
  }
  /* Constrain the most common fixed-width layout primitives */
  table, div, section, article, main, header, footer, aside, nav,
  figure, figcaption, form, fieldset, pre, blockquote {
    max-width: 100% !important;
  }
  /* Media and embedded objects must never overflow horizontally */
  img, svg, video, canvas, iframe, embed, object {
    max-width: 100% !important;
    height: auto !important;
  }
  /* Prevent horizontal overflow from pre/code blocks */
  pre {
    overflow-x: auto !important;
    white-space: pre-wrap !important;
    word-wrap: break-word !important;
  }
  /* Allow authors to opt out per-element when they really need fixed width */
  [data-teros-fixed-width] {
    max-width: none !important;
  }
`;

/**
 * Build a self-contained HTML document from raw content.
 *
 * Always injects {@link RESPONSIVE_CSS} so the rendered file fills the
 * available width of the FileViewer window. When the content already has
 * a full `<html>` document, the responsive `<style>` is inserted into the
 * existing `<head>` (or prepended to `<body>` if no head is present).
 */
function wrapHtml(content: string): string {
  // Already a full HTML document — inject the responsive CSS into <head>
  if (/<!DOCTYPE|<html/i.test(content)) {
    // Try to insert into <head> (after any existing <style>/<meta> for cascade order)
    const headMatch = content.match(/<head[^>]*>/i);
    if (headMatch) {
      const insertAt = headMatch.index! + headMatch[0].length;
      return content.slice(0, insertAt) + `\n  <style>${RESPONSIVE_CSS}</style>` + content.slice(insertAt);
    }
    // No <head> — try to prepend inside <body>
    const bodyMatch = content.match(/<body[^>]*>/i);
    if (bodyMatch) {
      const insertAt = bodyMatch.index! + bodyMatch[0].length;
      return content.slice(0, insertAt) + `\n  <style>${RESPONSIVE_CSS}</style>` + content.slice(insertAt);
    }
    // No head or body — just prepend the style block
    return `<style>${RESPONSIVE_CSS}</style>` + content;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #ffffff;
      overflow: auto; min-height: 100%;
    }
    ${RESPONSIVE_CSS}
  </style>
</head>
<body>
${content}
</body>
</html>`;
}

/** Format elapsed seconds as a human-readable string */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function FileViewerWindowContent({ windowId, filePath, channelId, workspaceId }: Props) {
  const c = useColors();
  const [htmlContent, setHtmlContent]     = useState<string | null>(null);
  const [error, setError]                 = useState<string | null>(null);

  // When the file content was last received from the backend
  const [lastReceived, setLastReceived]   = useState<Date | null>(null);

  // Ticker: current time, refreshed every second so relative times update live
  const [now, setNow]                     = useState<Date>(() => new Date());

  // Whether the WebSocket is connected
  const [connected, setConnected]         = useState<boolean>(false);

  const [updateKey, setUpdateKey]         = useState(0);
  const listenerRef                       = useRef<((msg: any) => void) | null>(null);
  const iframeRef                         = useRef<HTMLIFrameElement>(null);

  const client = getTerosClient();

  const filename = useMemo(() => filePath.split('/').pop() ?? filePath, [filePath]);

  // ── Tick every second ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Track WebSocket connection state ────────────────────────────────────────
  useEffect(() => {
    if (!client) return;

    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    // Set initial state
    setConnected(client.isConnected?.() ?? false);

    client.on('connected',    onConnect);
    client.on('disconnected', onDisconnect);
    return () => {
      client.off('connected',    onConnect);
      client.off('disconnected', onDisconnect);
    };
  }, [client]);

  // ── File watcher ────────────────────────────────────────────────────────────

  // Keep a ref to the latest startWatching to avoid stale closures in effects
  const startWatchingRef = useRef<() => void>(() => {});

  const startWatching = useCallback(() => {
    if (!client || !filePath || (!channelId && !workspaceId)) return;

    setError(null);

    // Remove any previous listener before registering a new one
    if (listenerRef.current) {
      client.off('file_changed', listenerRef.current);
      listenerRef.current = null;
    }

    const handler = (msg: { filePath: string; content: string }) => {
      if (msg.filePath !== filePath) return;
      setLastReceived(new Date());
      setHtmlContent(wrapHtml(msg.content));
      setUpdateKey((k) => k + 1);
    };

    listenerRef.current = handler as (...args: unknown[]) => void;
    client.on('file_changed', handler as (...args: unknown[]) => void);

    client.fileWatcher.watch(filePath, channelId!, workspaceId!).catch((err) => {
      console.warn("[FileViewerWindow] watchFile error:", err);
    });
  }, [client, filePath, channelId, workspaceId]);

  // Always keep the ref up to date
  useEffect(() => {
    startWatchingRef.current = startWatching;
  }, [startWatching]);

  // Start watching on mount and whenever filePath/channelId change
  useEffect(() => {
    startWatchingRef.current();

    return () => {
      if (client) {
        client.fileWatcher.unwatch(filePath).catch(() => {});
        if (listenerRef.current) {
          client.off('file_changed', listenerRef.current);
          listenerRef.current = null;
        }
      }
    };
  }, [filePath, channelId, workspaceId]);

  // Re-start watching whenever the WS reconnects (uses ref to avoid stale closure)
  useEffect(() => {
    if (!connected) return;
    startWatchingRef.current();
  }, [connected]);

  const handleRefresh = () => {
    setHtmlContent(null);
    startWatching();
  };

  // ── Derived display values ──────────────────────────────────────────────────
  const updatedAgo = lastReceived ? formatElapsed(now.getTime() - lastReceived.getTime()) : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <YStack flex={1} alignItems="center" justifyContent="center" padding={24} gap={12}>
        <Text color={semanticColors.red} fontSize={14} fontFamily="$body" textAlign="center">
          {error}
        </Text>
        <Button size="$3" onPress={handleRefresh} icon={<RefreshCw size={14} />}>
          Reintentar
        </Button>
      </YStack>
    );
  }

  if (!htmlContent) {
    return (
      <FullscreenLoader variant="default" />
    );
  }

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* ── Toolbar ── */}
      <XStack
        backgroundColor={c.bgCard}
        paddingHorizontal={12}
        paddingVertical={6}
        alignItems="center"
        gap={8}
        borderBottomWidth={1}
        borderBottomColor={c.borderStrong}
      >
        {/* Connection dot — green = connected, red = disconnected */}
        <YStack
          width={7}
          height={7}
          borderRadius={4}
          backgroundColor={connected ? semanticColors.green : semanticColors.red}
          flexShrink={0}
          // @ts-ignore web-only style
          style={
            Platform.OS === 'web' && connected
              ? { animation: 'pulse 2s infinite' }
              : undefined
          }
        />

        {/* File path */}
        <Text
          color={c.text2}
          fontSize={11}
          fontFamily="$mono"
          flex={1}
          numberOfLines={1}
        >
          {filePath}
        </Text>

        {/* Timing info */}
        {updatedAgo && (
          <Text color={c.text3} fontSize={10} fontFamily="$body">
            Updated{' '}
            <Text color={c.text2} fontSize={10} fontFamily="$body">
              {updatedAgo} ago
            </Text>
          </Text>
        )}

        {/* Share popover */}
        {client && channelId && (
          <SharePopover
            filePath={filePath}
            channelId={channelId}
            workspaceId={workspaceId}
            fileType="html"
            client={client}
          />
        )}

        {/* Refresh button */}
        <Button
          size="$2"
          chromeless
          icon={<RefreshCw size={12} color={c.text3} />}
          onPress={handleRefresh}
          pressStyle={{ opacity: 0.7 }}
        />
      </XStack>

      {/* ── HTML content ── */}
      {Platform.OS === 'web' ? (
        <iframe
          key={updateKey}
          ref={iframeRef}
          srcDoc={htmlContent}
          style={{
            flex: 1,
            border: 'none',
            width: '100%',
            height: '100%',
            backgroundColor: '#ffffff',
          }}
          sandbox="allow-scripts allow-same-origin"
          title={filename}
        />
      ) : (
        <WebView
          source={{ html: htmlContent }}
          style={{ flex: 1 }}
          originWhitelist={['*']}
          scrollEnabled
          javaScriptEnabled
        />
      )}
    </YStack>
  );
}
