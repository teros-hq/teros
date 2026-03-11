/**
 * FileViewerWindow Content
 *
 * Renders an HTML file in real time. On mount it calls `client.fileWatcher.watch()`
 * which sends a `file.watch` request via WsFramework; the backend resolves the
 * host path, sends the current file content immediately, then pushes `file.changed`
 * events via SubscriptionManager on every subsequent save. On unmount it calls
 * `client.fileWatcher.unwatch()` to stop the watcher.
 */

import { RefreshCw } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import WebView from 'react-native-webview';
import { Button, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import type { FileViewerWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface Props extends FileViewerWindowProps {
  windowId: string;
}

/** Build a self-contained HTML document from raw content */
function wrapHtml(content: string): string {
  if (/<!DOCTYPE|<html/i.test(content)) return content;

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

export function FileViewerWindowContent({ windowId, filePath, channelId }: Props) {
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
    if (!client || !filePath || !channelId) return;

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

    listenerRef.current = handler;
    client.on('file_changed', handler);

    client.fileWatcher.watch(filePath, channelId).catch((err) => {
      console.warn("[FileViewerWindow] watchFile error:", err);
    });
  }, [client, filePath, channelId]);

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
  }, [filePath, channelId]);

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
        <Text color="#ef4444" fontSize={14} textAlign="center">
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
    <YStack flex={1} backgroundColor="#ffffff">
      {/* ── Toolbar ── */}
      <XStack
        backgroundColor="rgba(24,24,27,0.95)"
        paddingHorizontal={12}
        paddingVertical={6}
        alignItems="center"
        gap={8}
        borderBottomWidth={1}
        borderBottomColor="rgba(255,255,255,0.08)"
      >
        {/* Connection dot — green = connected, red = disconnected */}
        <YStack
          width={7}
          height={7}
          borderRadius={4}
          backgroundColor={connected ? '#22c55e' : '#ef4444'}
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
          color="rgba(255,255,255,0.6)"
          fontSize={11}
          fontFamily="$mono"
          flex={1}
          numberOfLines={1}
        >
          {filePath}
        </Text>

        {/* Timing info */}
        {updatedAgo && (
          <Text color="rgba(255,255,255,0.35)" fontSize={10}>
            Updated{' '}
            <Text color="rgba(255,255,255,0.55)" fontSize={10}>
              {updatedAgo} ago
            </Text>
          </Text>
        )}

        <Button
          size="$2"
          chromeless
          icon={<RefreshCw size={12} color="rgba(255,255,255,0.5)" />}
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
