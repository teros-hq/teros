/**
 * BrowserbaseWindowContent
 *
 * Renders the Browserbase Live View in an iframe.
 * Shows the browser session in real time as the agent navigates.
 *
 * OS prototype chrome: a `PHead` strip (globe tile + serif title + session
 * badge + live dot + caption, refresh / open-external on the right) over
 * the live-view iframe, which keeps its own surface.
 */

import React, { useState } from "react"
import { Platform, View } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../../components/mca/primitives/useColors"
import { AppSpinner } from "../../components/ui"
import { Badge, EmptyState, IconBtn, PHead, T } from "../../components/ui/ds"
import type { BrowserbaseWindowProps } from "./definition"

interface Props extends BrowserbaseWindowProps {
  windowId: string
}

export function BrowserbaseWindowContent({ sessionId, liveViewUrl, caption }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const [key, setKey] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const shortId = sessionId.slice(0, 8)

  const handleRefresh = () => {
    setLoaded(false)
    setKey((k) => k + 1)
  }

  const handleOpenExternal = () => {
    if (Platform.OS === "web") {
      window.open(liveViewUrl, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      {/* ── Toolbar ── */}
      <PHead
        icon="globe"
        title={t("browserbase.session")}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {Platform.OS === "web" && !loaded ? <AppSpinner size="xs" variant="muted" /> : null}
            <IconBtn
              icon="arrows-clockwise"
              plain
              sm
              title={t("browserbase.reloadLiveView")}
              onPress={handleRefresh}
              testID="browserbase-refresh"
            />
            {Platform.OS === "web" && (
              <IconBtn
                icon="arrow-square-out"
                plain
                sm
                title={t("browserbase.openInNewTab")}
                onPress={handleOpenExternal}
                testID="browserbase-open-external"
              />
            )}
          </View>
        }
      >
        {/* Session ID badge */}
        <Badge tone="i" mono>{`${shortId}…`}</Badge>

        {/* Live indicator */}
        <Badge tone="g" dot pill>
          {t("browserbase.live")}
        </Badge>

        {/* Caption */}
        {caption ? (
          <T step="code" tone="text3" ellipsis style={{ flexShrink: 1 }}>
            {caption}
          </T>
        ) : null}
      </PHead>

      {/* ── Live View iframe ── */}
      {Platform.OS === "web" ? (
        <View style={{ flex: 1, overflow: "hidden", backgroundColor: c.bgStep }}>
          <iframe
            key={key}
            src={liveViewUrl}
            onLoad={() => setLoaded(true)}
            style={{
              flex: 1,
              border: "none",
              width: "100%",
              height: "100%",
              backgroundColor: c.bgStep,
              display: "block",
            }}
            allow="clipboard-read; clipboard-write"
            title={t("browserbase.iframeTitle", { shortId })}
          />
        </View>
      ) : (
        // React Native fallback — deep link to open externally
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="globe"
            title={t("browserbase.webOnly")}
            text={t("browserbase.sessionId", { sessionId })}
          />
        </View>
      )}
    </View>
  )
}
