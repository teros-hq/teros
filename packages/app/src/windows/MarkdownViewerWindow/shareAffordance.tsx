/**
 * The Markdown viewer's share affordance (docs/specs/todo/output-window.md,
 * TODOOV-REQ-8): one-click publish + copy on desktop, the SharePopover
 * (one share model for both sources) on the Published badge and on touch.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { AppSpinner } from "../../components/ui/AppSpinner"
import { copyLink, LINK_COPIED_MS, SharePopover, type SharePopoverModel, shareEnvironment } from "../../components/ui/SharePopover"
import { Badge, IconBtn, T } from "../../components/ui/ds"
import type { TerosClient } from "../../services/TerosClient"

/** Toolbar row height of the viewer's icon buttons (IconBtn sm). */
const ROW_H = 28

/**
 * @spec TODOOV-REQ-8 The file source's share model, over the existing
 * `client.fileShare` flow: an existing share is read on mount, publish
 * shares the file as markdown, unpublish revokes it.
 */
export function useFileShareModel(
  client: TerosClient | null,
  filePath: string,
  channelId: string | undefined,
  workspaceId: string | undefined,
  title: string,
): SharePopoverModel | null {
  const [state, setState] = useState<SharePopoverModel["state"]>("idle")
  const [shareId, setShareId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client || !filePath || !channelId) return
    let live = true
    client.fileShare
      .getShare(filePath, workspaceId)
      .then((info) => {
        if (!live || !info) return
        setShareId(info.shareId)
        setState("published")
      })
      .catch(() => {
        // Non-critical: the window stays unshared and Share can still publish.
      })
    return () => {
      live = false
    }
  }, [client, filePath, channelId, workspaceId])

  const publish = useCallback(async () => {
    if (!client || !channelId) return
    setState("publishing")
    setError(null)
    try {
      const info = await client.fileShare.share(filePath, channelId, "markdown")
      setShareId(info.shareId)
      setState("published")
    } catch (err) {
      setState("idle")
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [client, filePath, channelId])

  const unpublish = useCallback(async () => {
    if (!client || !shareId) return
    setError(null)
    try {
      await client.fileShare.unshare(shareId)
      setShareId(null)
      setState("idle")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [client, shareId])

  // Share is only available when opened from a chat context (channelId present).
  if (!client || !channelId) return null
  return { state, publicUrl: shareId ? client.fileShare.publicUrl(shareId) : null, publish, unpublish, title, error }
}

/**
 * @spec TODOOV-REQ-8 The toolbar's share affordance. Desktop (fine pointer):
 * one click on Share publishes, copies the link and shows Link copied, then
 * Published; only a refused copy opens the popover on the link. Touch: Share
 * publishes and opens the popover (with Share… when the native sheet exists).
 * The Published badge (centred with the icon buttons, the link as tooltip)
 * opens the popover.
 */
export function ShareAffordance({ model, testID = "markdown-share" }: { model: SharePopoverModel; testID?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [awaitingUrl, setAwaitingUrl] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const published = model.state === "published" && !!model.publicUrl
  const url = model.publicUrl ?? ""

  const showCopied = () => {
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), LINK_COPIED_MS)
  }

  // Once a publish delivers the link: desktop copies it (popover only if the
  // copy is refused); touch opens the popover on it.
  useEffect(() => {
    if (!awaitingUrl || model.state === "publishing") return
    setAwaitingUrl(false)
    if (!published) return
    if (!shareEnvironment().desktop) {
      setOpen(true)
      return
    }
    void copyLink(url).then((ok) => {
      if (ok) showCopied()
      else {
        setCopyFailed(true)
        setOpen(true)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingUrl, model.state, published, url])

  const onShare = () => {
    if (published) return setOpen((o) => !o)
    if (model.state !== "idle") return
    setCopyFailed(false)
    setAwaitingUrl(true)
    void model.publish()
  }

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (!o) setCopyFailed(false)
  }

  // Hover tooltip = the link (web `title`; react-native-web does not forward the prop).
  const badgeRef = useRef<View | null>(null)
  useEffect(() => {
    const el = badgeRef.current as unknown as HTMLElement | null
    if (Platform.OS === "web" && el?.setAttribute && model.publicUrl) el.setAttribute("title", model.publicUrl)
  }, [published, copied, model.publicUrl])

  return (
    <>
      {model.error ? (
        <View style={{ maxWidth: 260, flexShrink: 1, height: ROW_H, justifyContent: "center" }}>
          <T step="codenote" tone="danger" ellipsis style={{ textTransform: "none" }} testID={`${testID}-error`}>
            {model.error}
          </T>
        </View>
      ) : null}
      <SharePopover
        model={model}
        open={open}
        onOpenChange={onOpenChange}
        onLinkCopied={showCopied}
        copyFailed={copyFailed}
        testID={testID}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: ROW_H, flexShrink: 0 }}>
          {copied && published ? (
            <View testID={`${testID}-copied-badge`} style={{ height: ROW_H, justifyContent: "center" }}>
              <Badge tone="g" pill dot style={{ alignSelf: "center" }}>
                {t("markdownViewer.share.linkCopied")}
              </Badge>
            </View>
          ) : published ? (
            <Pressable
              ref={badgeRef}
              testID={`${testID}-published`}
              onPress={() => setOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`${t("markdownViewer.share.published")}: ${model.publicUrl}`}
              style={[{ height: ROW_H, justifyContent: "center" }, Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null]}
            >
              <Badge tone="m" pill icon="link" style={{ alignSelf: "center" }}>
                {t("markdownViewer.share.published")}
              </Badge>
            </Pressable>
          ) : null}
          {model.state === "publishing" ? (
            <View testID={`${testID}-publishing`} style={{ width: ROW_H, height: ROW_H, alignItems: "center", justifyContent: "center" }}>
              <AppSpinner size="sm" />
            </View>
          ) : (
            <IconBtn
              icon="share-network"
              plain
              sm
              on={published}
              onPress={onShare}
              accessibilityLabel={t("markdownViewer.share.button")}
              title={t("markdownViewer.share.button")}
              testID={testID}
            />
          )}
        </View>
      </SharePopover>
    </>
  )
}
