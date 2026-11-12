/**
 * An HTML file io rendered in place: a sandboxed iframe (`allow-scripts` only,
 * opaque origin: scripts run but cannot reach Teros cookies, storage or context;
 * NEVER add `allow-same-origin` — with allow-scripts it lets content drop its own
 * sandbox. No forms, no top navigation) loading the object URL on
 * the kit's page card, 420 px tall (the page's own height is unknown); `full`
 * fills its container. On native: the generic file card.
 * @spec TODOOV-REQ-9
 */
import React from "react"
import { Platform, View, type ViewStyle } from "react-native"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { FileTile, usePageStyle } from "./FileCard"

export const HTML_PREVIEW_HEIGHT = 420

/** @spec TODOOV-REQ-9 */
export function HtmlPreview({ url, name, full }: { url: string; name: string; full?: boolean }) {
  const td = useTd()
  const page = usePageStyle()
  if (Platform.OS !== "web") return <FileTile name={name} />
  return (
    <View
      style={[
        ...page,
        { aspectRatio: undefined, borderRadius: 12, ...(full ? { flex: 1, height: "100%" } : { height: HTML_PREVIEW_HEIGHT }) },
        web({ boxShadow: `0 0 0 1px ${td.borderStrong}, 0 1px 2px rgba(32,28,39,.10), 0 18px 36px -18px rgba(32,28,39,.5)` }) as ViewStyle,
      ]}
    >
      {React.createElement("iframe", {
        src: url,
        title: name,
        sandbox: "allow-scripts",
        style: { width: "100%", height: "100%", border: 0, display: "block", background: "#fff" },
      })}
    </View>
  )
}
