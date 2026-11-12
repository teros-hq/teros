/**
 * Read views of a NodeIO: form as key → value, markdown as a document, a file
 * as an inline row; an HTML file also renders in place (TODOOV-REQ-9).
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { Linking, Pressable, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { NodeIO } from "../model/types"
import { Btn, Tx } from "../ui/kit"
import { Markdown } from "../ui/Markdown"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { FilePreview } from "./FilePreview"
import { extOf, fileKind, formValue, humanSize } from "./io"

export function KeyValues({ io }: { io: Extract<NodeIO, { format: "form" }> }) {
  const td = useTd()
  return (
    <View style={{ minWidth: 0 }}>
      {io.fields.map((f, i) => {
        const v = formValue(io.values?.[f.id])
        const last = i === io.fields.length - 1
        return (
          <View
            key={f.id}
            style={{ flexDirection: "row", borderBottomWidth: last ? 0 : 1, borderBottomColor: td.borderStrong }}
          >
            <View style={{ minWidth: 110, maxWidth: 200, paddingVertical: 8, paddingRight: 14 }}>
              <Tx f="mono" s={10.5} lh={20} c={td.txs}>
                {f.label}
              </Tx>
            </View>
            <View style={{ flex: 1, minWidth: 0, paddingVertical: 8 }}>
              <Tx s={13.5} lh={20} c={v ? td.text : td.text3}>
                {v || "—"}
              </Tx>
            </View>
          </View>
        )
      })}
    </View>
  )
}

export function FileInline({ io }: { io: Extract<NodeIO, { format: "file" }> }) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, backgroundColor: td.card },
        web({ boxShadow: td.sheetShadow }) as ViewStyle,
      ]}
    >
      <View
        style={[
          { width: 30, height: 36, borderRadius: 4, backgroundColor: td.paper, alignItems: "center", justifyContent: "center" },
          web({ boxShadow: "0 0 0 1px #E5DFEF" }) as ViewStyle,
        ]}
      >
        <Tx f="mono" s={7.5} lh={9} c="#797386">
          {extOf(io.name)}
        </Tx>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Tx s={13.5} lh={18} c={td.text} lines={1}>
          {io.name}
        </Tx>
        <Tx f="mono" s={10} lh={14} c={td.txs}>
          {humanSize(io.size)}
        </Tx>
      </View>
      <Btn sm tone="out" onPress={() => Linking.openURL(io.url)}>
        {t("todo.io.open")}
      </Btn>
    </View>
  )
}

export function IOBody({ io }: { io: NodeIO }) {
  if (io.format === "form") return <KeyValues io={io} />
  if (io.format === "markdown") return <Markdown source={io.markdown} />
  if (fileKind(io.mime, io.name) === "html") {
    return (
      <View style={{ gap: 10 }}>
        <FileInline io={io} />
        <FilePreview url={io.url} name={io.name} mime={io.mime} />
      </View>
    )
  }
  return <FileInline io={io} />
}

export function FoldHeader({
  open,
  label,
  right,
  onPress,
}: {
  open: boolean
  label: string
  right?: string
  onPress: () => void
}) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={[{ flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 14 }, web({ cursor: "pointer" }) as ViewStyle]}
    >
      {({ hovered }: any) => (
        <>
          <View style={web({ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s cubic-bezier(.16,1,.3,1)" }) as ViewStyle}>
            <Ph name="caret-right" size={10} color={td.text3} />
          </View>
          <Tx s={10} lh={12} c={hovered ? td.text2 : td.txs} ls={1.7} upper>
            {label}
          </Tx>
          {right ? (
            <Tx f="mono" s={10} lh={12} c={td.txs} ls={0.3} style={{ marginLeft: "auto" }}>
              {right}
            </Tx>
          ) : null}
        </>
      )}
    </Pressable>
  )
}
