/**
 * Salida: the delivered result. Markdown renders as a document card, a form
 * as key → value, a file as a page preview plus its meta. *Open* shows a
 * markdown output in the Markdown viewer window beside the detail and a file
 * in a new browser tab (TODOOV-REQ-6). Without output: the empty box with "Upload file" /
 * "Write markdown" (set-output, base64 ≤ 10 MB). In review the Accept /
 * Send back bar closes the panel. While there is no output, the expected
 * output definition is edited below the empty box; once an output exists it
 * reads as a one-line summary above it (TODOAP-REQ-14). A form definition
 * offers "Fill in": it creates the form output with empty values and the
 * form becomes the working surface, edited in place (TODOAP-REQ-16).
 */
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Linking, Platform, Pressable, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { ExpectedOutput, NodeDetail, NodeIO } from "../model/types"
import { Btn, Lnk, Tx } from "../ui/kit"
import { Markdown } from "../ui/Markdown"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { ExpectedOutputEditor, ExpectedOutputSummary } from "./ExpectedOutput"
import { FilePreview } from "./FilePreview"
import { FormFill } from "./FormFill"
import { extOf, humanSize, ioLabel } from "./io"
import { MarkdownEditor } from "./SummaryTab"

interface Props {
  node: NodeDetail
  /** Time of the last set-output (review/done: "delivered", before: "in progress · saved"). */
  deliveredAt: string | null
  wide: boolean
  uploading: boolean
  onOutput: (action: "file" | "markdown" | "remove", markdown?: string) => void
  /** Expected output definition, editable while there is no output (TODOAP-REQ-14). */
  onExpectedOutput: (def: ExpectedOutput | null) => void
  /** Creates the form output from the form definition, empty values (TODOAP-REQ-16). */
  onFill: () => void
  /** A form output edited in place: applied at once, then saved debounced (TODOAP-REQ-16). */
  onFormPatch: (output: Extract<NodeIO, { format: "form" }>) => void
  onFormSave: (output: Extract<NodeIO, { format: "form" }>) => void
  /** @spec TODOOV-REQ-6 Opens a markdown output in the Markdown viewer window. */
  onOpen: () => void
}

function Fmt({ children, color }: { children: string; color?: string }) {
  const td = useTd()
  return (
    <View style={{ height: 24, paddingHorizontal: 10, borderRadius: 100, backgroundColor: td.wash2, justifyContent: "center" }}>
      <Tx f="mono" s={10.5} lh={12} c={color ?? td.text2}>
        {children}
      </Tx>
    </View>
  )
}

/** @spec TODOOV-REQ-6 A file output opens in a new browser tab. */
function openInNewTab(url: string): void {
  if (Platform.OS === "web") window.open(url, "_blank", "noopener")
  else void Linking.openURL(url)
}

export function OutputTab({ node, deliveredAt, wide, uploading, onOutput, onExpectedOutput, onFill, onFormPatch, onFormSave, onOpen }: Props) {
  const td = useTd()
  const { t } = useTranslation()
  const [writing, setWriting] = useState<string | null>(null)
  const o = node.output

  const editLinks = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginTop: 10, marginLeft: -9 }}>
      <Lnk icon="upload-simple" onPress={() => onOutput("file")}>
        {uploading ? t("todo.io.uploading") : o ? t("todo.io.replace") : t("todo.io.upload")}
      </Lnk>
      <Lnk icon="pencil-simple" onPress={() => setWriting(o?.format === "markdown" ? o.markdown : "")}>
        {t("todo.io.writeMarkdown")}
      </Lnk>
      {o ? (
        <Lnk icon="x" onPress={() => onOutput("remove")}>
          {t("todo.io.remove")}
        </Lnk>
      ) : null}
    </View>
  )

  if (writing !== null) {
    return (
      <View style={{ marginTop: 18 }}>
        <MarkdownEditor
          value={writing}
          onChange={setWriting}
          onCancel={() => setWriting(null)}
          onSave={() => {
            onOutput("markdown", writing)
            setWriting(null)
          }}
        />
      </View>
    )
  }

  if (!o) {
    const def = node.expectedOutput
    const fillable = def?.format === "form" && !!def.fields?.length
    return (
      <View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 18, marginBottom: 10 }}>
          <Fmt>{t("todo.io.none")}</Fmt>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: td.step, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16 }}>
          <Ph name="file-text" size={16} color={td.text3} />
          <Tx s={13} lh={19} c={td.text2} style={{ flex: 1 }}>
            {t("todo.io.noOutput")}
          </Tx>
          {fillable ? (
            <Btn tone="pri" icon="pencil-simple-line" onPress={onFill}>
              {t("todo.expected.fillIn")}
            </Btn>
          ) : null}
        </View>
        {editLinks}
        <ExpectedOutputEditor value={node.expectedOutput} onChange={onExpectedOutput} />
      </View>
    )
  }

  const head = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 18, marginBottom: 10 }}>
      {node.expectedOutput ? <ExpectedOutputSummary value={node.expectedOutput} /> : <Fmt>{ioLabel(o, t)}</Fmt>}
      {node.state === "blocked" && o.format === "file" ? <Fmt color={td.rTx}>{t("todo.io.draft")}</Fmt> : null}
      {deliveredAt ? (
        <Tx f="mono" s={10} lh={14} c={td.txs}>
          {node.state === "review" || node.state === "done"
            ? t("todo.io.deliveredAt", { when: deliveredAt })
            : t("todo.io.savedAt", { when: deliveredAt })}
        </Tx>
      ) : null}
      <View style={{ flex: 1 }} />
      {o.format !== "form" ? (
        <Btn sm tone="out" icon="arrow-square-out" onPress={o.format === "markdown" ? onOpen : () => openInNewTab(o.url)}>
          {t("todo.io.open")}
        </Btn>
      ) : null}
    </View>
  )

  let body: React.ReactNode = null
  if (o.format === "markdown") {
    body = (
      <View style={[{ backgroundColor: td.card, borderRadius: 16, paddingTop: 20, paddingHorizontal: 22, paddingBottom: 14 }, web({ boxShadow: td.cardShadow }) as ViewStyle]}>
        <Markdown source={o.markdown} />
      </View>
    )
  } else if (o.format === "form") {
    body = <FormFill io={o} onPatch={onFormPatch} onSave={onFormSave} />
  } else {
    const preview = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("todo.io.open")} ${o.name}`}
        onPress={() => openInNewTab(o.url)}
        style={({ hovered }: any) => [
          { borderRadius: 14, padding: 14, backgroundColor: hovered ? td.wash2 : td.step, minWidth: 0, ...(wide ? { flexGrow: 1.15, flexShrink: 1, flexBasis: 0 } : { alignSelf: "stretch" }) },
          web({ cursor: "pointer", transition: "background .2s" }) as ViewStyle,
        ]}
      >
        <FilePreview url={o.url} name={o.name} mime={o.mime} />
      </Pressable>
    )
    const meta = (
      <View style={{ gap: 10, minWidth: 0, ...(wide ? { flexGrow: 1, flexShrink: 1, flexBasis: 0 } : {}) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Ph name="file-text" size={16} color={td.text3} />
          <Tx s={13.5} lh={18} c={td.text} lines={1} style={{ flexShrink: 1 }}>
            {o.name}
          </Tx>
        </View>
        <Tx f="mono" s={10} lh={14} c={td.txs}>
          {`${extOf(o.name)} · ${humanSize(o.size)}`}
        </Tx>
        <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
          <Btn sm tone="out" icon="download-simple" onPress={() => Linking.openURL(o.url)}>
            {t("todo.io.download")}
          </Btn>
        </View>
      </View>
    )
    body = <View style={{ flexDirection: wide ? "row" : "column", gap: 16, alignItems: "flex-start", minWidth: 0 }}>{preview}{meta}</View>
  }

  return (
    <View>
      {head}
      {body}
      {editLinks}
    </View>
  )
}
