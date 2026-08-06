/**
 * MarkdownViewerWindowContent
 *
 * Main component for the Markdown Viewer window.
 *
 * Lifecycle:
 *   1. On mount (or filePath/channelId change): call client.fileWatcher.watch()
 *      and listen for the first `file_changed` event.
 *   2. Once content is received: unwatch (read-once model per spec) and render.
 *   3. Refresh button: re-initiates the watch → receive → unwatch cycle.
 *   4. "← Back" button (only when returnPath is provided): opens the File Browser
 *      at the returnPath directory.
 *
 * Error handling:
 *   - File not found / permission denied / WS disconnect → descriptive error + Retry
 *   - Markdown parse error → "Could not render" + raw fallback if possible
 */

import { ArrowLeft, Check, RefreshCw, Share2, X } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { AppSpinner } from '../../components/ui';
import { useTilingStore } from '../../store/tilingStore';
import type { MarkdownViewerWindowProps } from './definition';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { useColors } from '../../components/mca/primitives/useColors';
import { surface, colors as semanticColors } from '../../components/mca/primitives/colors';

interface Props extends MarkdownViewerWindowProps {
  windowId: string;
}

type LoadState = 'loading' | 'loaded' | 'error';
type ShareState = 'idle' | 'publishing' | 'published';

export function MarkdownViewerWindowContent({
  windowId,
  filePath,
  channelId,
  workspaceId,
  returnPath,
}: Props) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const [content, setContent]       = useState<string | null>(null);
  const [loadState, setLoadState]   = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg]     = useState<string>('');
  const [loadKey, setLoadKey]       = useState(0); // increment to trigger re-load

  // ── Share state ────────────────────────────────────────────────────────────
  const [shareState, setShareState]         = useState<ShareState>('idle');
  const [shareId, setShareId]               = useState<string | null>(null);
  const [sharePublicUrl, setSharePublicUrl] = useState<string | null>(null);
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [shareHovered, setShareHovered]     = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listenerRef = useRef<((msg: any) => void) | null>(null);
  const unwatchedRef = useRef(false); // guard: only unwatch once per load cycle

  const openWindow = useTilingStore((s) => s.openWindow);
  const client = getTerosClient();

  const filename = filePath.split('/').pop() ?? filePath;

  // ── Load file ──────────────────────────────────────────────────────────────

  const startLoading = useCallback(() => {
    if (!client || !filePath || (!channelId && !workspaceId)) return;

    setLoadState('loading');
    setContent(null);
    setErrorMsg('');
    unwatchedRef.current = false;

    // Remove any stale listener from a previous load cycle
    if (listenerRef.current) {
      client.off('file_changed', listenerRef.current);
      listenerRef.current = null;
    }

    const handler = (msg: { filePath: string; content: string; error?: string }) => {
      if (msg.filePath !== filePath) return;

      // Read-once: stop watching after the first event
      if (!unwatchedRef.current) {
        unwatchedRef.current = true;
        client.fileWatcher.unwatch(filePath).catch(() => {});
        client.off('file_changed', handler as (...args: unknown[]) => void);
        listenerRef.current = null;
      }

      if (msg.error) {
        setErrorMsg(msg.error);
        setLoadState('error');
        return;
      }

      setContent(msg.content ?? '');
      setLoadState('loaded');
    };

    listenerRef.current = handler as (...args: unknown[]) => void;
    client.on('file_changed', handler as (...args: unknown[]) => void);

    client.fileWatcher.watch(filePath, channelId!, workspaceId!).catch((err: Error) => {
      const msg = err?.message ?? 'Unknown error';
      // Distinguish common error types
      if (/not found|ENOENT/i.test(msg)) {
        setErrorMsg(`File not found: ${filePath}`);
      } else if (/permission|EACCES/i.test(msg)) {
        setErrorMsg('Cannot read file: permission denied.');
      } else if (/connect|websocket/i.test(msg)) {
        setErrorMsg('Connection lost. Could not load file.');
      } else {
        setErrorMsg(`Could not load file: ${msg}`);
      }
      setLoadState('error');

      // Clean up listener
      if (listenerRef.current) {
        client.off('file_changed', listenerRef.current);
        listenerRef.current = null;
      }
    });
  }, [client, filePath, channelId, workspaceId]);

  // ── Restore existing share on mount ───────────────────────────────────────
  // Share is only supported when opened from a chat context (channelId available)
  useEffect(() => {
    if (!client || !filePath || !channelId) return;
    client.fileShare.getShare(filePath, workspaceId).then((info) => {
      if (info) {
        setShareId(info.shareId);
        setSharePublicUrl(client.fileShare.publicUrl(info.shareId));
        setShareState('published');
      }
    }).catch(() => {
      // Non-critical: if this fails, user can still re-publish manually
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, channelId, workspaceId]);

  // Trigger load on mount and when loadKey changes (refresh)
  useEffect(() => {
    startLoading();

    return () => {
      // Cleanup on unmount or before next effect run
      if (listenerRef.current) {
        client?.off('file_changed', listenerRef.current);
        listenerRef.current = null;
      }
      // Best-effort unwatch if we haven't already
      if (!unwatchedRef.current && client) {
        client.fileWatcher.unwatch(filePath).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, channelId, workspaceId, loadKey]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    setLoadKey((k) => k + 1);
  };

  const handleBack = () => {
    if (!returnPath) return;
    // Open (or focus) the File Browser at returnPath
    openWindow('file-browser', { initialPath: returnPath }, false);
  };

  const handleShare = async () => {
    if (!client || shareState !== 'idle') return;
    setShareState('publishing');
    try {
      const result = await client.fileShare.share(filePath, channelId!, 'markdown');
      setShareId(result.shareId);
      setSharePublicUrl((result as any).publicUrl);
      setShareState('published');
      try {
        await navigator.clipboard.writeText((result as any).publicUrl);
        setCopiedFeedback(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopiedFeedback(false), 2000);
      } catch {
        // clipboard not available — silently ignore
      }
    } catch {
      setShareState('idle');
    }
  };

  const handleUnshare = async () => {
    if (!client || !shareId || shareState !== 'published') return;
    try {
      await client.fileShare.unshare(shareId);
    } catch {
      // best-effort
    }
    setShareId(null);
    setSharePublicUrl(null);
    setShareState('idle');
  };

  // Cleanup copied timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>

      {/* ── Toolbar ── */}
      <XStack
        backgroundColor={isDark ? 'rgba(24,24,27,0.95)' : c.bgCard}
        paddingHorizontal={12}
        paddingVertical={6}
        alignItems="center"
        gap={8}
        borderBottomWidth={1}
        borderBottomColor={c.border}
        flexShrink={0}
      >
        {/* ← Back button (only when returnPath is provided) */}
        {returnPath && (
          <Button
            size="$2"
            chromeless
            icon={<ArrowLeft size={12} color={c.text2} />}
            onPress={handleBack}
            pressStyle={{ opacity: 0.7 }}
          >
            <Text color={c.text2} fontSize={11}>
              Back
            </Text>
          </Button>
        )}

        {/* File icon + name */}
        <YStack flex={1} overflow="hidden" gap={1}>
          <Text
            color={c.text}
            fontSize={12}
            fontWeight="600"
            numberOfLines={1}
          >
            {filename}
          </Text>
          <Text
            color={c.text3}
            fontSize={10}
            fontFamily="$mono"
            numberOfLines={1}
          >
            {filePath}
          </Text>
        </YStack>

        {/* "Enlace copiado" inline feedback */}
        {copiedFeedback && (
          <Text color={semanticColors.green} fontSize={10}>
            Enlace copiado
          </Text>
        )}

        {/* Share button — only available when opened from a chat context (channelId present) */}
        {!!channelId && shareState === 'idle' && (
          <Button
            size="$2"
            chromeless
            icon={<Share2 size={12} color={c.text3} />}
            onPress={handleShare}
            pressStyle={{ opacity: 0.7 }}
          />
        )}
        {!!channelId && shareState === 'publishing' && (
          <Button
            size="$2"
            chromeless
            disabled
            icon={<AppSpinner size="sm" />}
          />
        )}
        {!!channelId && shareState === 'published' && (
          <Button
            size="$2"
            chromeless
            icon={
              shareHovered
                ? <X size={12} color={semanticColors.red} />
                : <Check size={12} color={semanticColors.green} />
            }
            onPress={handleUnshare}
            pressStyle={{ opacity: 0.7 }}
            // @ts-ignore web-only
            onMouseEnter={() => setShareHovered(true)}
            onMouseLeave={() => setShareHovered(false)}
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

      {/* ── Content area ── */}
      {loadState === 'loading' && (
        <YStack flex={1} alignItems="center" justifyContent="center" gap={12}>
          <AppSpinner size="md" />
          <Text color={c.text3} fontSize={13}>
            Loading {filename}…
          </Text>
        </YStack>
      )}

      {loadState === 'error' && (
        <YStack flex={1} alignItems="center" justifyContent="center" padding={24} gap={12}>
          <Text fontSize={24}>⚠️</Text>
          <Text
            color={semanticColors.red}
            fontSize={14}
            textAlign="center"
            maxWidth={480}
          >
            {errorMsg || 'An unknown error occurred.'}
          </Text>
          <Button
            size="$3"
            onPress={handleRefresh}
            icon={<RefreshCw size={14} />}
          >
            Retry
          </Button>
        </YStack>
      )}

      {loadState === 'loaded' && content !== null && (
        // MarkdownRenderer handles its own ScrollView on native.
        // On web, wrap in a ScrollView so the toolbar stays fixed at the top.
        Platform.OS === 'web' ? (
          <ScrollView
            style={{ flex: 1, backgroundColor: c.bgPage }}
            contentContainerStyle={{ flexGrow: 1 }}
          >
            <MarkdownRenderer content={content} />
          </ScrollView>
        ) : (
          <MarkdownRenderer content={content} />
        )
      )}
    </YStack>
  );
}
