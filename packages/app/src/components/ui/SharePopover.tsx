/**
 * SharePopover
 *
 * A reusable popover for sharing files publicly.
 * Shows two states:
 *  - idle: prompt to publish with a "Publicar enlace" button
 *  - published: shows the public URL with Copy and Unpublish actions
 *

 *
 * Colors use the design system: surface/text/border tokens come from
 * `useColors()` (theme-adaptive), semantic colors (red) from
 * `semanticColors`, and the Teros brand cyan is a local constant.
 */

import { Share2 } from '@tamagui/lucide-icons'
import React, { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { Button, Popover, Spinner, Text, XStack, YStack } from 'tamagui'
import { useColors } from '../mca/primitives/useColors'
import { colors as semanticColors, controlsBar } from '../mca/primitives/colors'
import type { TerosClient } from '../../services/TerosClient'

// ─── Brand constants (Teros cyan — not in the semantic palette) ─────────────

const BRAND_CYAN = '#06b6d4'
const BRAND_CYAN_HOVER = '#0891b2'

// ============================================================================
// Types
// ============================================================================

type ShareState = 'loading' | 'idle' | 'publishing' | 'published' | 'unpublishing' | 'error'

interface Props {
  filePath: string
  /** Channel ID — used by the publish flow to derive workspace context server-side. */
  channelId: string
  /** Workspace ID — when provided, disambiguates the lookup of an existing share
   *  (the same filePath can exist in multiple workspaces owned by the user). */
  workspaceId?: string
  fileType: 'html' | 'markdown'
  client: TerosClient
}

// ============================================================================
// SharePopover
// ============================================================================

export function SharePopover({ filePath, channelId, workspaceId, fileType, client }: Props) {
  const [open, setOpen]             = useState(false)
  const [shareState, setShareState] = useState<ShareState>('loading')
  const [shareId, setShareId]       = useState<string | null>(null)
  const [publicUrl, setPublicUrl]   = useState<string | null>(null)
  const [copied, setCopied]         = useState(false)
  const [errorMsg, setErrorMsg]     = useState<string | null>(null)

  const c = useColors()

  // ── Load existing share on mount (or when token becomes available) ────────
  useEffect(() => {
    let cancelled = false

    const loadShare = () => {
      // Don't attempt if there's no token yet
      if (!client.getSessionToken()) return
      setShareState('loading')
      client.fileShare.getShare(filePath, workspaceId).then((info) => {
        if (cancelled) return
        if (info) {
          setShareId(info.shareId)
          setPublicUrl(client.fileShare.publicUrl(info.shareId))
          setShareState('published')
        } else {
          setShareState('idle')
        }
      }).catch(() => {
        if (!cancelled) setShareState('idle')
      })
    }

    // Try immediately (token may already be available)
    loadShare()

    // Also listen for authentication in case token wasn't ready yet
    const onAuthenticated = () => { if (!cancelled) loadShare() }
    client.on('authenticated', onAuthenticated)

    return () => {
      cancelled = true
      client.off('authenticated', onAuthenticated)
    }
  }, [filePath, workspaceId, client])

  // ── Actions ───────────────────────────────────────────────────────────────

  const handlePublish = async () => {
    setShareState('publishing')
    setErrorMsg(null)
    try {
      const info = await client.fileShare.share(filePath, channelId, fileType)
      setShareId(info.shareId)
      setPublicUrl(client.fileShare.publicUrl(info.shareId))
      setShareState('published')
    } catch (err: any) {
      setErrorMsg(err?.message ?? 'Error al publicar')
      setShareState('error')
    }
  }

  const handleUnshare = async () => {
    if (!shareId) return
    setShareState('unpublishing')
    setErrorMsg(null)
    try {
      await client.fileShare.unshare(shareId)
      setShareId(null)
      setPublicUrl(null)
      setShareState('idle')
      setOpen(false)
    } catch (err: any) {
      setErrorMsg(err?.message ?? 'Error al despublicar')
      setShareState('published')
    }
  }

  const handleCopy = async () => {
    if (!publicUrl) return
    const filename = filePath.split('/').pop() ?? filePath
    try {
      if (Platform.OS !== 'web' && (navigator as any).share) {
        await (navigator as any).share({ title: filename, url: publicUrl })
        return
      }
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && 'share' in navigator) {
        await navigator.share({ title: filename, url: publicUrl })
        return
      }
    } catch (_) { /* fall through */ }
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) { /* unavailable */ }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const isLoading   = shareState === 'loading'
  const isPublished = shareState === 'published' || shareState === 'unpublishing'
  const isIdle      = shareState === 'idle' || shareState === 'error' || shareState === 'publishing'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Popover open={open} onOpenChange={setOpen} placement="bottom-end">

      {/* ── Trigger: share icon in toolbar ── */}
      <Popover.Trigger asChild>
        <Button
          size="$2"
          chromeless
          borderRadius={7}
          backgroundColor={shareState === 'published' ? 'rgba(6,182,212,0.1)' : 'transparent'}
          icon={
            isLoading
              ? <Spinner size="small" color={c.text3} />
              : <Share2 size={12} color={shareState === 'published' ? BRAND_CYAN : c.text3} />
          }
          onPress={() => setOpen((v) => !v)}
          pressStyle={{ opacity: 0.7 }}
        />
      </Popover.Trigger>

      {/* ── Popover panel ── */}
      <Popover.Content
        backgroundColor={c.bgCard}
        borderWidth={1}
        borderColor={c.borderStrong}
        borderRadius={12}
        padding={0}
        elevate
        animation="quick"
        enterStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        exitStyle={{ opacity: 0, y: -6, scale: 0.97 }}
      >
        {/* Fixed-width container — all children inherit this width */}
        <YStack width={300} overflow="hidden">

          {/* ── Loading ── */}
          {isLoading && (
            <YStack alignItems="center" justifyContent="center" padding="$4">
              <Spinner size="small" color={BRAND_CYAN} />
            </YStack>
          )}

          {/* ── Idle / Error / Publishing ── */}
          {isIdle && (
            <>
              {/* Header */}
              <XStack
                alignItems="center"
                justifyContent="space-between"
                paddingHorizontal={16}
                paddingTop={14}
                paddingBottom={12}
                borderBottomWidth={1}
                borderBottomColor={c.border}
              >
                <Text color={c.text} fontSize={13} fontWeight="600">
                  Compartir archivo
                </Text>
                <Button
                  size="$1"
                  chromeless
                  width={22}
                  height={22}
                  borderRadius={6}
                  hoverStyle={{ backgroundColor: c.bgCardHover }}
                  pressStyle={{ opacity: 0.7 }}
                  onPress={() => setOpen(false)}
                >
                  ✕
                </Button>
              </XStack>

              {/* Body */}
              <YStack paddingHorizontal={16} paddingTop={14} paddingBottom={16} gap={12}>
                <Text color={c.text3} fontSize={12.5} lineHeight={19}>
                  Genera un enlace público para compartir este archivo con cualquiera.
                </Text>

                {shareState === 'error' && errorMsg && (
                  <Text color={semanticColors.red} fontSize={11}>
                    {errorMsg}
                  </Text>
                )}

                <Button
                  height={34}
                  backgroundColor={BRAND_CYAN}
                  borderWidth={0}
                  borderRadius={8}
                  color="#fff"
                  fontSize={13}
                  fontWeight="600"
                  disabled={shareState === 'publishing'}
                  opacity={shareState === 'publishing' ? 0.7 : 1}
                  onPress={handlePublish}
                  pressStyle={{ transform: [{ scale: 0.98 }] }}
                  hoverStyle={{ backgroundColor: BRAND_CYAN_HOVER }}
                  icon={shareState === 'publishing' ? <Spinner size="small" color="#fff" /> : undefined}
                >
                  {shareState === 'publishing' ? 'Publicando…' : 'Publicar enlace'}
                </Button>
              </YStack>
            </>
          )}

          {/* ── Published / Unpublishing ── */}
          {isPublished && publicUrl && (
            <>
              {/* Header */}
              <XStack
                alignItems="center"
                justifyContent="space-between"
                paddingHorizontal={16}
                paddingTop={14}
                paddingBottom={12}
                borderBottomWidth={1}
                borderBottomColor={c.border}
              >
                {/* Title + badge */}
                <XStack alignItems="center" gap={8}>
                  <Text color={c.text} fontSize={13} fontWeight="600">
                    Compartir archivo
                  </Text>
                  <XStack
                    backgroundColor="rgba(6,182,212,0.12)"
                    borderWidth={1}
                    borderColor="rgba(6,182,212,0.25)"
                    borderRadius={4}
                    paddingHorizontal={6}
                    paddingVertical={2}
                  >
                    <Text
                      color={BRAND_CYAN}
                      fontSize={10}
                      fontWeight="600"
                      textTransform="uppercase"
                      letterSpacing={0.4}
                    >
                      Publicado
                    </Text>
                  </XStack>
                </XStack>

                <Button
                  size="$1"
                  chromeless
                  width={22}
                  height={22}
                  borderRadius={6}
                  hoverStyle={{ backgroundColor: c.bgCardHover }}
                  pressStyle={{ opacity: 0.7 }}
                  onPress={() => setOpen(false)}
                >
                  ✕
                </Button>
              </XStack>

              {/* Body */}
              <YStack paddingHorizontal={16} paddingTop={14} paddingBottom={16} gap={12}>
                <Text color={c.text3} fontSize={11.5}>
                  Comparte este enlace con quien quieras
                </Text>

                {/* URL row — flex row, URL truncates, copy button stays visible */}
                <XStack
                  alignItems="center"
                  gap={8}
                  backgroundColor={c.bgInner}
                  borderWidth={1}
                  borderColor={c.border}
                  borderRadius={8}
                  paddingHorizontal={10}
                  paddingVertical={8}
                >
                  <Text
                    flex={1}
                    fontSize={11.5}
                    fontFamily="$mono"
                    color={c.text2}
                    numberOfLines={1}
                    overflow="hidden"
                  >
                    {publicUrl}
                  </Text>

                  <Button
                    flexShrink={0}
                    height={26}
                    paddingHorizontal={10}
                    backgroundColor={BRAND_CYAN}
                    borderWidth={0}
                    borderRadius={6}
                    color="#fff"
                    fontSize={11.5}
                    fontWeight="600"
                    onPress={handleCopy}
                    pressStyle={{ opacity: 0.85 }}
                    hoverStyle={{ backgroundColor: BRAND_CYAN_HOVER }}
                  >
                    {copied ? '¡Copiado!' : 'Copiar'}
                  </Button>
                </XStack>

                {/* Unpublish */}
                <Button
                  height={30}
                  backgroundColor="transparent"
                  borderWidth={1}
                  borderColor={controlsBar.deny.border}
                  borderRadius={7}
                  fontSize={12}
                  fontWeight="500"
                  disabled={shareState === 'unpublishing'}
                  opacity={shareState === 'unpublishing' ? 0.6 : 1}
                  onPress={handleUnshare}
                  pressStyle={{ opacity: 0.75 }}
                  hoverStyle={{
                    borderColor: semanticColors.red,
                    backgroundColor: controlsBar.deny.bg,
                  }}
                  icon={shareState === 'unpublishing' ? <Spinner size="small" color={semanticColors.red} /> : undefined}
                >
                  {shareState === 'unpublishing' ? 'Despublicando…' : 'Despublicar'}
                </Button>
              </YStack>
            </>
          )}

        </YStack>
      </Popover.Content>
    </Popover>
  )
}
