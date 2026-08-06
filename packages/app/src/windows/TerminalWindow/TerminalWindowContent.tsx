/**
 * TerminalWindowContent — PTY-based interactive terminal
 *
 * Renders an xterm.js terminal inside a WebView/iframe connected to a real
 * PTY running bash inside the MCA bash Docker container via node-pty +
 * docker exec. Supports vim, htop, tab completion, and all interactive programs.
 *
 * Bridge protocol (RN ↔ xterm bundle):
 *   RN → xterm:  { type: 'output', data }   — raw PTY output
 *                { type: 'clear' }           — clear screen
 *   xterm → RN:  { type: 'ready' }           — xterm initialized
 *                { type: 'input', data }      — keystrokes to send to PTY
 *                { type: 'resize', cols, rows } — terminal resized
 */

import { AlertCircle, Terminal } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { Button, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { AppSpinner } from '../../components/ui';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';
import type { TerminalWindowProps } from './definition';
import { terminalHtml } from './terminalBundle';
import { useBashApp } from './useBashApp';

interface Props extends TerminalWindowProps {
  windowId: string;
}

export function TerminalWindowContent({
  windowId,
  initialCwd,
  appId: propAppId,
  workspaceId: propWorkspaceId,
}: Props) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const webViewRef = useRef<WebView>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Use refs to avoid stale closure issues — these never trigger re-renders
  const ptyCreatedRef = useRef(false);
  const xtermSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const appIdRef = useRef<string | undefined>(undefined);
  const clientRef = useRef<any>(null);

  const client = getTerosClient();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const effectiveWorkspaceId = propWorkspaceId ?? activeWorkspaceId ?? '';

  const { appId: resolvedAppId, loading: appLoading } = useBashApp(
    propAppId ? undefined : effectiveWorkspaceId,
  );
  const effectiveAppId = propAppId ?? resolvedAppId;

  // Keep refs in sync — update synchronously during render to avoid stale closure
  // when the 'ready' message arrives from the iframe right after mount
  clientRef.current = client;
  appIdRef.current = effectiveAppId ?? undefined;

  // ── injectJS: send message to xterm bundle ────────────────────────────────

  const injectJS = useCallback((msg: object) => {
    const data = JSON.stringify(msg);
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(data, '*');
    } else {
      webViewRef.current?.injectJavaScript(
        `window.terosTerminal && window.terosTerminal.receive(${JSON.stringify(data)}); true;`,
      );
    }
  }, []);

  // ── createPty: uses refs so it's always fresh ─────────────────────────────

  const createPty = useCallback((cols: number, rows: number) => {
    const appId = appIdRef.current;
    const c = clientRef.current;
    if (ptyCreatedRef.current || !appId || !c) {
      console.log('[Terminal] createPty skipped — created:', ptyCreatedRef.current, 'appId:', appId, 'client:', !!c);
      return;
    }
    console.log('[Terminal] creating PTY — terminalId:', windowId, 'appId:', appId, 'cols:', cols, 'rows:', rows);
    ptyCreatedRef.current = true;
    c.send('terminal', 'create', { terminalId: windowId, appId, cols, rows })
      .catch((err: any) => {
        console.error('[Terminal] failed to create PTY:', err);
        ptyCreatedRef.current = false;
      });
  }, [windowId]);

  // ── PTY output/exit listeners ─────────────────────────────────────────────

  useEffect(() => {
    if (!client) return;

    const handleOutput = (event: any) => {
      if (event.terminalId === windowId && event.data) {
        injectJS({ type: 'output', data: event.data });
      }
    };
    const handleExit = (event: any) => {
      if (event.terminalId === windowId) {
        injectJS({ type: 'output', data: '\r\n\x1b[33m[session ended]\x1b[0m\r\n' });
        ptyCreatedRef.current = false;
      }
    };

    client.on('terminal_output', handleOutput);
    client.on('terminal_exit', handleExit);

    return () => {
      client.off('terminal_output', handleOutput);
      client.off('terminal_exit', handleExit);
      if (ptyCreatedRef.current) {
        client.send('terminal', 'destroy', { terminalId: windowId }).catch(() => {});
        ptyCreatedRef.current = false;
      }
    };
  }, [client, windowId, injectJS]);

  // ── When appId resolves, create PTY if xterm is already ready ────────────

  useEffect(() => {
    if (effectiveAppId && xtermSizeRef.current && !ptyCreatedRef.current) {
      createPty(xtermSizeRef.current.cols, xtermSizeRef.current.rows);
    }
  }, [effectiveAppId, createPty]);

  // ── Bridge: messages from xterm bundle ───────────────────────────────────

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready': {
          const cols = msg.cols ?? 80;
          const rows = msg.rows ?? 24;
          xtermSizeRef.current = { cols, rows };
          createPty(cols, rows);
          break;
        }
        case 'input':
          clientRef.current?.send('terminal', 'input', { terminalId: windowId, data: msg.data }).catch(() => {});
          break;
        case 'resize':
          xtermSizeRef.current = { cols: msg.cols, rows: msg.rows };
          clientRef.current?.send('terminal', 'resize', { terminalId: windowId, cols: msg.cols, rows: msg.rows }).catch(() => {});
          break;
      }
    },
    [windowId, createPty],
  );

  // ── Web: listen to iframe postMessage ────────────────────────────────────

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onMsg = (e: MessageEvent) => {
      // Only handle messages from our own iframe
      if (e.source !== iframeRef.current?.contentWindow) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data && data.type) {
          handleMessage({ nativeEvent: { data: JSON.stringify(data) } } as any);
        }
      } catch {}
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [handleMessage]);

  // ── Web: when iframe loads, ask xterm for its current size ───────────────
  // This handles the race condition where xterm sends 'ready' before the
  // parent's message listener is registered.

  const handleIframeLoad = useCallback(() => {
    // Give xterm a moment to initialize, then ask for size
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type: 'get-size' }),
        '*',
      );
    }, 100);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Terminal surface stays dark in both themes — xterm.js renders its own
  // dark color scheme inside the iframe/WebView, so a light container would
  // flash mismatched color during load. We use bgCard in dark mode and a
  // neutral dark in light mode to avoid the flash.
  const terminalBg = isDark ? c.bgCard : '#1e1e24';

  const iframeStyle: React.CSSProperties = {
    flex: 1,
    border: 'none',
    width: '100%',
    height: '100%',
    background: terminalBg,
  };

  if (!appLoading && !effectiveAppId) {
    return (
      <YStack flex={1} backgroundColor={terminalBg} alignItems="center" justifyContent="center" gap={12} padding={24}>
        <AlertCircle size={32} color={semanticColors.red} />
        <Text color={semanticColors.red} fontSize={13} fontWeight="600" textAlign="center">{t('terminal.noBashApp')}</Text>
        <Text color={c.text2} fontSize={12} textAlign="center">{t('terminal.installBashHint')}</Text>
      </YStack>
    );
  }

  return (
    <YStack flex={1} backgroundColor={terminalBg}>
      <XStack backgroundColor={isDark ? 'rgba(20,21,25,0.98)' : c.bgInner} paddingHorizontal={10} paddingVertical={5} alignItems="center" gap={8} borderBottomWidth={1} borderBottomColor={c.border}>
        <Terminal size={13} color={semanticColors.green} />
        <Text fontFamily="$mono" fontSize={11} color={semanticColors.green} fontWeight="600">bash</Text>
        <Button size="$1" chromeless onPress={() => injectJS({ type: 'clear' })}>
          <Text fontFamily="$mono" fontSize={10} color={c.text3}>clear</Text>
        </Button>
      </XStack>

      {appLoading ? (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <AppSpinner size="md" />
        </YStack>
      ) : (
        Platform.OS === 'web' ? (
          <iframe ref={iframeRef} srcDoc={terminalHtml} style={iframeStyle} title={t('windows.terminal')} onLoad={handleIframeLoad} />
        ) : (
          <WebView ref={webViewRef} source={{ html: terminalHtml }} onMessage={handleMessage} javaScriptEnabled scrollEnabled={false} style={{ flex: 1, backgroundColor: terminalBg }} originWhitelist={['*']} />
        )
      )}
    </YStack>
  );
}
