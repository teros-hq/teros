/**
 * SharePopover
 *
 * A reusable popover for sharing files publicly. With a `model` prop it is
 * driven by a share model instead of the file props (TODOOV-REQ-8: the
 * Markdown viewer's file and To Do sources), with the link in a read-only
 * selectable field and one row Copy / Open / Revoke (+ Share… with a native
 * share sheet).
 * Shows two states:
 *  - idle: prompt to publish with a "Publicar enlace" button
 *  - published: shows the public URL with Copy and Unpublish actions
 *
 * Design: the OS prototype's card (radius 16, violet lift, hairline rows) and
 * pill buttons — colours from `useColors()`, Phosphor glyphs, 400 weight.
 */

import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Linking, Platform, TextInput, useWindowDimensions, View } from "react-native"
import { Popover } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import type { TerosClient } from "../../services/TerosClient"
import { AppSpinner } from "./AppSpinner"
import { Badge, Btn, IconBtn, T } from "./ds"

// ============================================================================
// Types
// ============================================================================

type ShareState = "loading" | "idle" | "publishing" | "published" | "unpublishing" | "error"

interface FileProps {
  model?: undefined
  filePath: string
  /** Channel ID — used by the publish flow to derive workspace context server-side. */
  channelId: string
  /** Workspace ID — when provided, disambiguates the lookup of an existing share
   *  (the same filePath can exist in multiple workspaces owned by the user). */
  workspaceId?: string
  fileType: "html" | "markdown" | "file"
  client: TerosClient
}

// ============================================================================
// SharePopover
// ============================================================================

type Props = FileProps | ModelSharePopoverProps

/**
 * The share popover. With `model` it is driven by a share model (any source:
 * the Markdown viewer's file and To Do sources, TODOOV-REQ-8); otherwise by
 * the file props through `client.fileShare` (chat bubbles, file viewer).
 */
export function SharePopover(props: Props) {
  return props.model ? <ModelSharePopover {...props} model={props.model} /> : <FileSharePopover {...props} />
}

function FileSharePopover({ filePath, channelId, workspaceId, fileType, client }: FileProps) {
  const [open, setOpen] = useState(false)
  const [shareState, setShareState] = useState<ShareState>("loading")
  const [shareId, setShareId] = useState<string | null>(null)
  const [publicUrl, setPublicUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const c = useColors()

  // ── Load existing share on mount (or when token becomes available) ────────
  useEffect(() => {
    let cancelled = false

    const loadShare = () => {
      // Don't attempt if there's no token yet
      if (!client.getSessionToken()) return
      setShareState("loading")
      client.fileShare
        .getShare(filePath, workspaceId)
        .then((info) => {
          if (cancelled) return
          if (info) {
            setShareId(info.shareId)
            setPublicUrl(client.fileShare.publicUrl(info.shareId))
            setShareState("published")
          } else {
            setShareState("idle")
          }
        })
        .catch(() => {
          if (!cancelled) setShareState("idle")
        })
    }

    // Try immediately (token may already be available)
    loadShare()

    // Also listen for authentication in case token wasn't ready yet
    const onAuthenticated = () => {
      if (!cancelled) loadShare()
    }
    client.on("authenticated", onAuthenticated)

    return () => {
      cancelled = true
      client.off("authenticated", onAuthenticated)
    }
  }, [filePath, workspaceId, client])

  // ── Actions ───────────────────────────────────────────────────────────────

  const handlePublish = async () => {
    setShareState("publishing")
    setErrorMsg(null)
    try {
      const info = await client.fileShare.share(filePath, channelId, fileType)
      setShareId(info.shareId)
      setPublicUrl(client.fileShare.publicUrl(info.shareId))
      setShareState("published")
    } catch (err: any) {
      setErrorMsg(err?.message ?? "Error al publicar")
      setShareState("error")
    }
  }

  const handleUnshare = async () => {
    if (!shareId) return
    setShareState("unpublishing")
    setErrorMsg(null)
    try {
      await client.fileShare.unshare(shareId)
      setShareId(null)
      setPublicUrl(null)
      setShareState("idle")
      setOpen(false)
    } catch (err: any) {
      setErrorMsg(err?.message ?? "Error al despublicar")
      setShareState("published")
    }
  }

  const handleCopy = async () => {
    if (!publicUrl) return
    const filename = filePath.split("/").pop() ?? filePath
    try {
      if (Platform.OS !== "web" && (navigator as any).share) {
        await (navigator as any).share({ title: filename, url: publicUrl })
        return
      }
      if (Platform.OS === "web" && typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ title: filename, url: publicUrl })
        return
      }
    } catch (_) {
      /* fall through */
    }
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) {
      /* unavailable */
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const isLoading = shareState === "loading"
  const isPublished = shareState === "published" || shareState === "unpublishing"
  const isIdle = shareState === "idle" || shareState === "error" || shareState === "publishing"

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <T step="hsm" ellipsis>
          Compartir archivo
        </T>
        {isPublished ? (
          <Badge tone="g" dot cap>
            Publicado
          </Badge>
        ) : null}
      </View>
      <IconBtn icon="x" plain sm onPress={() => setOpen(false)} />
    </View>
  )

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Popover open={open} onOpenChange={setOpen} placement="bottom-end">
      {/* ── Trigger: share icon in toolbar ── */}
      <Popover.Trigger asChild>
        {isLoading ? (
          <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
            <AppSpinner size="sm" variant="muted" />
          </View>
        ) : (
          <IconBtn
            icon="share-network"
            plain
            sm
            on={shareState === "published"}
            onPress={() => setOpen((v) => !v)}
            title="Compartir"
          />
        )}
      </Popover.Trigger>

      {/* ── Popover panel ── */}
      <Popover.Content
        backgroundColor={c.bgStep}
        borderWidth={0}
        borderRadius={16}
        padding={0}
        elevate
        animation="quick"
        enterStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        exitStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
      >
        {/* Fixed-width container — all children inherit this width */}
        <View style={{ width: 300, overflow: "hidden", borderRadius: 16 }}>
          {/* ── Loading ── */}
          {isLoading && (
            <View style={{ alignItems: "center", justifyContent: "center", padding: 20 }}>
              <AppSpinner size="sm" />
            </View>
          )}

          {/* ── Idle / Error / Publishing ── */}
          {isIdle && (
            <>
              {header}
              <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 12 }}>
                <T step="12" tone="text2" style={{ lineHeight: 18 }}>
                  Genera un enlace público para compartir este archivo con cualquiera.
                </T>

                {shareState === "error" && errorMsg && (
                  <T step="12" tone="danger">
                    {errorMsg}
                  </T>
                )}

                <Btn
                  variant="primary"
                  size="md"
                  full
                  icon="globe-simple"
                  loading={shareState === "publishing"}
                  onPress={handlePublish}
                >
                  {shareState === "publishing" ? "Publicando…" : "Publicar enlace"}
                </Btn>
              </View>
            </>
          )}

          {/* ── Published / Unpublishing ── */}
          {isPublished && publicUrl && (
            <>
              {header}
              <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 12 }}>
                <T step="12" tone="text3">
                  Comparte este enlace con quien quieras
                </T>

                {/* URL row — URL truncates, copy button stays visible */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    backgroundColor: c.field,
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: 10,
                    paddingLeft: 12,
                    paddingRight: 4,
                    height: 36,
                  }}
                >
                  <T step="code" tone="text2" ellipsis style={{ flex: 1, fontSize: 11 }}>
                    {publicUrl}
                  </T>
                  <Btn
                    variant="ink"
                    size="sm"
                    icon={copied ? "check" : "copy"}
                    onPress={handleCopy}
                  >
                    {copied ? "¡Copiado!" : "Copiar"}
                  </Btn>
                </View>

                {/* Unpublish */}
                <Btn
                  variant="dangerSoft"
                  size="sm"
                  icon="link-break"
                  loading={shareState === "unpublishing"}
                  onPress={handleUnshare}
                  style={{ alignSelf: "flex-start" }}
                >
                  {shareState === "unpublishing" ? "Despublicando…" : "Despublicar"}
                </Btn>
              </View>
            </>
          )}
        </View>
      </Popover.Content>
    </Popover>
  )
}

// ============================================================================
// Model-driven popover (TODOOV-REQ-8)
// ============================================================================

/** @spec TODOOV-REQ-8 One share model for any shareable source. */
export interface SharePopoverModel {
  state: "idle" | "publishing" | "published"
  publicUrl: string | null
  publish(): Promise<void>
  unpublish(): Promise<void>
  /** Title handed to the native share sheet. */
  title: string
  /** Last publish / revoke failure. */
  error?: string | null
}

/**
 * @spec TODOOV-REQ-8 Props of the model-driven popover: a compact card on a
 * published link (read-only field across the full width, then one
 * right-aligned row Copy · Share… · Open · Revoke whose pills never resize). `open` is controlled by the caller, which also supplies the anchor
 * (`children`: the toolbar's badge + Share button).
 */
export interface ModelSharePopoverProps {
  model: SharePopoverModel
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired when Copy puts the link on the clipboard. */
  onLinkCopied?: () => void
  /** Show the "Copy it by hand" hint (the caller's own copy failed). */
  copyFailed?: boolean
  children: React.ReactNode
  testID?: string
}

/** How long "Link copied" stays (TODOOV-REQ-8: "for a few seconds"). */
export const LINK_COPIED_MS = 3000

/**
 * @spec TODOOV-REQ-8 Desktop = a fine pointer that can hover, whatever
 * `navigator.share` says; anything else (mobile web, native) is touch.
 * `nativeShare` = the native share sheet is available.
 */
export function shareEnvironment(): { desktop: boolean; nativeShare: boolean } {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { share?: unknown }) : undefined
  const nativeShare = typeof nav?.share === "function"
  const mq = (q: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches
  const desktop = Platform.OS === "web" && mq("(pointer: fine)") && !mq("(hover: none)")
  return { desktop, nativeShare }
}

/** @spec TODOOV-REQ-8 Write the link to the clipboard; false when the write is refused or unavailable. */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

function ModelSharePopover({
  model,
  open,
  onOpenChange,
  onLinkCopied,
  copyFailed: callerCopyFailed,
  children,
  testID = "share-popover",
}: ModelSharePopoverProps) {
  const c = useColors()
  const { t } = useTranslation()
  const { width: winWidth } = useWindowDimensions()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useEffect(() => {
    if (!open) {
      setCopied(false)
      setCopyFailed(false)
    }
  }, [open])

  const url = model.publicUrl ?? ""
  const published = model.state === "published" && !!model.publicUrl

  const copy = async () => {
    const ok = await copyLink(url)
    setCopyFailed(!ok)
    setCopied(ok)
    if (!ok) return
    onLinkCopied?.()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), LINK_COPIED_MS)
  }

  const revoke = async () => {
    setRevoking(true)
    try {
      await model.unpublish()
    } finally {
      setRevoking(false)
    }
  }
  // Revoke closes the popover once the link is gone.
  useEffect(() => {
    if (open && !published && !revoking && model.state === "idle") onOpenChange(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [published, revoking, model.state])

  const openLink = () => {
    if (Platform.OS === "web") window.open(url, "_blank", "noopener")
    else void Linking.openURL(url)
  }

  const nativeShare = () => {
    const nav = navigator as Navigator & { share?: (d: { url: string; title: string }) => Promise<void> }
    nav.share?.({ url, title: model.title })?.catch?.(() => {
      // Sheet dismissed or failed: the field stays visible for a manual copy.
    })
  }

  const showHint = copyFailed || (!!callerCopyFailed && !copied)

  return (
    <Popover open={open && published} onOpenChange={onOpenChange} placement="bottom-end" offset={6} allowFlip stayInFrame={{ padding: 16 }}>
      <Popover.Anchor>{children}</Popover.Anchor>

      <Popover.Content
        backgroundColor={c.bgStep}
        borderWidth={0}
        borderRadius={16}
        padding={0}
        elevate
        animation="quick"
        enterStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        exitStyle={{ opacity: 0, y: -6, scale: 0.97 }}
        {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
      >
        <View testID={`${testID}-popover`} style={{ width: Math.min(420, winWidth - 32), padding: 12, gap: 10 }}>
          {/* The link: read-only, selectable, always visible for a manual copy. */}
          <View
            style={{
              justifyContent: "center",
              backgroundColor: c.field,
              borderWidth: 1,
              borderColor: showHint ? c.tint.a.tx : c.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              height: 36,
            }}
          >
            <TextInput
              value={url}
              editable={false}
              selectTextOnFocus
              accessibilityLabel={t("markdownViewer.share.linkLabel")}
              testID={`${testID}-url`}
              style={[
                { color: c.text2, fontSize: 11, fontFamily: "monospace", padding: 0, backgroundColor: "transparent", borderWidth: 0 },
                Platform.OS === "web" ? ({ outlineStyle: "none", userSelect: "all" } as any) : null,
              ]}
            />
          </View>

          {copied ? (
            <T step="12" tone="text2" testID={`${testID}-copied`}>
              {t("markdownViewer.share.linkCopied")}
            </T>
          ) : null}
          {showHint ? (
            <T step="12" tone="text2" testID={`${testID}-copy-hint`}>
              {t("markdownViewer.share.copyByHand")}
            </T>
          ) : null}

          {/* One right-aligned row of pills that never change size (Copy keeps its
              label; the confirmation is the line above); it may wrap on a phone. */}
          <View
            testID={`${testID}-actions`}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}
          >
            <Btn variant="ink" size="sm" icon={copied ? "check" : "copy"} onPress={() => void copy()} testID={`${testID}-copy`}>
              {t("markdownViewer.share.copy")}
            </Btn>
            {!shareEnvironment().desktop && shareEnvironment().nativeShare ? (
              <Btn variant="primary" size="sm" icon="share-network" onPress={nativeShare} testID={`${testID}-native`}>
                {t("markdownViewer.share.share")}
              </Btn>
            ) : null}
            <Btn variant="sec" size="sm" icon="arrow-square-out" onPress={openLink} testID={`${testID}-open`}>
              {t("markdownViewer.share.open")}
            </Btn>
            <Btn
              variant="dangerSoft"
              size="sm"
              icon="link-break"
              loading={revoking}
              onPress={() => void revoke()}
              testID={`${testID}-revoke`}
            >
              {t("markdownViewer.share.revoke")}
            </Btn>
          </View>
        </View>
      </Popover.Content>
    </Popover>
  )
}
