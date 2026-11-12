/**
 * Resumen: description, instructions as tickable checkboxes with the "Done
 * when" box and counters, the collapsed input, and the child tasks with
 * "+ Child task". Everything is editable in place (parity with the agent
 * tools: update-node, toggle-instruction-item, set-input, add-node).
 */
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, TextInput, View, type TextStyle, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { parseInstructions, type InstrItem } from "../model/instructions"
import type { NodeDetail, NodeIO, TreeNode } from "../model/types"
import { Btn, Dot, Eyebrow, Lnk, Tx } from "../ui/kit"
import { tdx, web } from "../ui/todoFx"
import { F, useTd } from "../ui/tokens"
import { FoldHeader, IOBody } from "./IOBlocks"
import { ioLabel } from "./io"

interface Props {
  node: NodeDetail
  kids: TreeNode[]
  isGroup: boolean
  onUpdate: (fields: { description?: string; instructions?: string }) => void
  onTick: (index: number) => void
  onInput: (action: "file" | "markdown" | "remove", markdown?: string) => void
  onOpenChild: (id: string) => void
  onAddChild: (text: string) => void
  onSendToReview: () => void
  inputOpen: boolean
  setInputOpen: (v: boolean) => void
  addSignal: number
  inputWriteSignal: number
  descriptionSignal: number
  /** @spec TODOOV-REQ-6 Opens a markdown input in the Markdown viewer window. */
  onOpenInput?: () => void
}

export function SummaryTab(p: Props) {
  const { t } = useTranslation()
  return (
    <View>
      <Description value={p.node.description} onSave={(description) => p.onUpdate({ description })} editSignal={p.descriptionSignal} />
      {!p.isGroup ? (
        <Instructions node={p.node} onSave={(instructions) => p.onUpdate({ instructions })} onTick={p.onTick} onSendToReview={p.onSendToReview} />
      ) : null}
      <InputFold io={p.node.input} open={p.inputOpen} setOpen={p.setInputOpen} onInput={p.onInput} writeSignal={p.inputWriteSignal} onOpen={p.onOpenInput} />
      <Children
        kids={p.kids}
        title={p.isGroup ? t("todo.section.content") : t("todo.section.children")}
        isGroup={p.isGroup}
        onOpen={p.onOpenChild}
        onAdd={p.onAddChild}
        addSignal={p.addSignal}
      />
    </View>
  )
}

export function Description({ value, onSave, editSignal = 0 }: { value: string; onSave: (v: string) => void; editSignal?: number }) {
  const td = useTd()
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  React.useEffect(() => {
    if (editSignal > 0) {
      setDraft(value)
      setEditing(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSignal])
  const commit = () => {
    setEditing(false)
    if (draft.trim() !== value.trim()) onSave(draft.trim())
  }
  // An empty description renders nothing (as the mock); "Write description" lives in the ⋯ menu.
  if (!value && !editing) return null
  return (
    <View>
      <Eyebrow first>{t("todo.section.description")}</Eyebrow>
      {editing ? (
        <TextInput
          autoFocus
          multiline
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          placeholder={t("todo.descriptionPlaceholder")}
          placeholderTextColor={td.text3}
          style={[
            { fontFamily: F.sans, fontSize: 14, lineHeight: 21, color: td.text, minHeight: 64, borderRadius: 12, backgroundColor: td.card, paddingVertical: 8, paddingHorizontal: 10, maxWidth: 620 },
            web({ outlineStyle: "none", boxShadow: "0 0 0 1px rgba(111,39,255,.35)" }) as TextStyle,
          ]}
        />
      ) : (
        <Pressable onPress={() => (setDraft(value), setEditing(true))} style={[{ maxWidth: 620, borderRadius: 8 }, web({ cursor: "text" }) as ViewStyle]}>
          <Tx s={14} lh={21} c={td.text2}>
            {value}
          </Tx>
        </Pressable>
      )}
    </View>
  )
}

function CheckRow({ item, onTick }: { item: Extract<InstrItem, { kind: "check" }>; onTick: (i: number) => void }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: item.checked }}
      accessibilityLabel={item.text}
      onPress={() => onTick(item.index)}
      style={({ hovered }: any) => [
        { flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 30, paddingVertical: 5, paddingHorizontal: 6, marginLeft: -6, borderRadius: 8, backgroundColor: hovered ? td.wash : "transparent" },
        web({ cursor: "pointer" }) as ViewStyle,
      ]}
    >
      <View
        style={[
          { width: 16, height: 16, marginTop: 2, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: item.checked ? td.iBg : "transparent" },
          web({ boxShadow: item.checked ? "none" : `inset 0 0 0 1.25px ${td.text3}`, transition: "background .2s, box-shadow .2s" }) as ViewStyle,
        ]}
      >
        {item.checked ? <Ph name="check" size={10} color={td.accent} weight="bold" /> : null}
      </View>
      <Tx
        s={13.5}
        lh={20}
        c={item.checked ? td.txs : td.text}
        style={[{ flex: 1 }, item.checked ? ({ textDecorationLine: "line-through", textDecorationColor: td.text3 } as TextStyle) : null]}
      >
        {item.text}
      </Tx>
    </Pressable>
  )
}

function ItemsList({ items, onTick }: { items: InstrItem[]; onTick: (i: number) => void }) {
  const td = useTd()
  return (
    <View style={{ gap: 1 }}>
      {items.map((it, k) =>
        it.kind === "check" ? (
          <CheckRow key={`c${it.index}`} item={it} onTick={onTick} />
        ) : it.kind === "heading" ? (
          <Tx key={`h${k}`} s={10} lh={12} c={td.txs} ls={1.6} upper style={{ marginTop: 14, marginBottom: 4 }}>
            {it.text}
          </Tx>
        ) : (
          <Tx key={`p${k}`} s={13.5} lh={20} c={td.text2} style={{ marginTop: 2, marginBottom: 6 }}>
            {it.text}
          </Tx>
        ),
      )}
    </View>
  )
}

function Instructions({
  node,
  onSave,
  onTick,
  onSendToReview,
}: {
  node: NodeDetail
  onSave: (v: string) => void
  onTick: (i: number) => void
  onSendToReview: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.instructions)
  const parsed = parseInstructions(node.instructions)
  if (editing)
    return (
      <View>
        <Eyebrow
          right={
            <View style={{ flexDirection: "row", gap: 2 }}>
              <Lnk onPress={() => setEditing(false)}>{t("todo.cancel")}</Lnk>
              <Lnk
                onPress={() => {
                  setEditing(false)
                  if (draft !== node.instructions) onSave(draft)
                }}
              >
                {t("todo.save")}
              </Lnk>
            </View>
          }
        >
          {t("todo.section.instructions")}
        </Eyebrow>
        <TextInput
          autoFocus
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder={t("todo.instructionsPlaceholder")}
          placeholderTextColor={td.text3}
          accessibilityLabel={t("todo.section.instructions")}
          style={[
            { minHeight: 180, borderRadius: 12, backgroundColor: td.card, paddingVertical: 10, paddingHorizontal: 12, fontFamily: F.mono, fontSize: 12, lineHeight: 19, color: td.text },
            web({ outlineStyle: "none", boxShadow: "0 0 0 1px rgba(111,39,255,.45)", resize: "vertical" }) as TextStyle,
          ]}
        />
      </View>
    )
  if (!node.instructions.trim())
    return (
      <View>
        <Eyebrow right={<Lnk icon="pencil-simple" onPress={() => (setDraft(""), setEditing(true))}>{t("todo.write")}</Lnk>}>
          {t("todo.section.instructions")}
        </Eyebrow>
        <Tx s={14} lh={21} c={td.text3} style={{ maxWidth: 620 }}>
          {t("todo.noInstructions")}
        </Tx>
      </View>
    )
  const allDone = parsed.doneChecks.total > 0 && parsed.doneChecks.checked === parsed.doneChecks.total
  return (
    <View>
      <Eyebrow
        count={parsed.checks.total ? `${parsed.checks.checked}/${parsed.checks.total}` : null}
        right={<Lnk icon="pencil-simple" onPress={() => (setDraft(node.instructions), setEditing(true))}>{t("todo.edit")}</Lnk>}
      >
        {t("todo.section.instructions")}
      </Eyebrow>
      <ItemsList items={parsed.steps} onTick={onTick} />
      {parsed.hasDoneWhen ? (
        <View style={{ marginTop: 10, borderRadius: 14, backgroundColor: td.step, paddingTop: 2, paddingRight: 12, paddingBottom: 8, paddingLeft: 14 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 10, marginBottom: 4 }}>
            <Tx s={10} lh={12} c={td.txs} ls={1.6} upper>
              {t("todo.section.doneWhen")}
            </Tx>
            <Tx f="mono" s={10} lh={12} c={td.text2} ls={0.3}>
              {`${parsed.doneChecks.checked}/${parsed.doneChecks.total}`}
            </Tx>
          </View>
          <ItemsList items={parsed.doneWhen} onTick={onTick} />
        </View>
      ) : null}
      {allDone && node.state === "working" ? (
        <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ph name="check" size={12} color={td.gTx} />
          <Tx s={12.5} lh={16} c={td.gTx}>
            {t("todo.readyForReview")}
          </Tx>
          <View style={{ marginLeft: "auto" }}>
            <Btn sm tone="pri" onPress={onSendToReview}>
              {t("todo.verb.working_review")}
            </Btn>
          </View>
        </View>
      ) : null}
    </View>
  )
}

export function InputFold({
  io,
  open,
  setOpen,
  onInput,
  writeSignal = 0,
  onOpen,
}: {
  io: NodeIO | null
  open: boolean
  setOpen: (v: boolean) => void
  onInput: Props["onInput"]
  writeSignal?: number
  /** @spec TODOOV-REQ-6 */
  onOpen?: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [writing, setWriting] = useState<string | null>(null)
  React.useEffect(() => {
    if (writeSignal > 0) setWriting(io?.format === "markdown" ? io.markdown : "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeSignal])
  if (!io && writing === null) return null
  return (
    <View style={{ borderRadius: 14, backgroundColor: td.step, marginTop: 20 }}>
      <FoldHeader open={open || writing !== null} label={t("todo.section.input")} right={io ? ioLabel(io, t) : undefined} onPress={() => setOpen(!open)} />
      {open || writing !== null ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 10 }}>
          {writing !== null ? (
            <MarkdownEditor
              value={writing}
              onChange={setWriting}
              onCancel={() => setWriting(null)}
              onSave={() => {
                onInput("markdown", writing)
                setWriting(null)
              }}
            />
          ) : io ? (
            <IOBody io={io} />
          ) : null}
          {writing === null ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginLeft: -9 }}>
              {io?.format === "markdown" && onOpen ? (
                <Lnk icon="arrow-square-out" onPress={onOpen}>
                  {t("todo.io.open")}
                </Lnk>
              ) : null}
              <Lnk icon="upload-simple" onPress={() => onInput("file")}>
                {t("todo.io.upload")}
              </Lnk>
              <Lnk icon="pencil-simple" onPress={() => setWriting(io?.format === "markdown" ? io.markdown : "")}>
                {t("todo.io.writeMarkdown")}
              </Lnk>
              {io ? (
                <Lnk icon="x" onPress={() => onInput("remove")}>
                  {t("todo.io.remove")}
                </Lnk>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        autoFocus
        multiline
        value={value}
        onChangeText={onChange}
        placeholder={t("todo.io.markdownPlaceholder")}
        placeholderTextColor={td.text3}
        style={[
          { minHeight: 160, borderRadius: 12, backgroundColor: td.card, paddingVertical: 10, paddingHorizontal: 12, fontFamily: F.mono, fontSize: 12, lineHeight: 19, color: td.text },
          web({ outlineStyle: "none", boxShadow: "0 0 0 1px rgba(111,39,255,.45)", resize: "vertical" }) as TextStyle,
        ]}
      />
      <View style={{ flexDirection: "row", gap: 6, justifyContent: "flex-end" }}>
        <Btn sm tone="ghost" onPress={onCancel}>
          {t("todo.cancel")}
        </Btn>
        <Btn sm tone="pri" disabled={!value.trim()} onPress={onSave}>
          {t("todo.save")}
        </Btn>
      </View>
    </View>
  )
}

export function Children({
  kids,
  title,
  isGroup,
  onOpen,
  onAdd,
  addSignal = 0,
}: {
  kids: TreeNode[]
  title: string
  isGroup: boolean
  onOpen: (id: string) => void
  onAdd: (text: string) => void
  addSignal?: number
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  React.useEffect(() => {
    if (addSignal > 0) setAdding(true)
  }, [addSignal])
  const tasks = kids.filter((k) => k.kind !== "group")
  const commit = () => {
    const v = draft.trim()
    setDraft("")
    setAdding(false)
    if (v) onAdd(v)
  }
  return (
    <View>
      <Eyebrow count={tasks.length ? `${tasks.filter((k) => k.state === "done").length}/${tasks.length}` : null}>{title}</Eyebrow>
      <View style={{ gap: 1 }}>
        {kids.map((k) => {
          const isTask = k.kind !== "group"
          const p = isTask ? Math.max(0, Math.min(100, k.progress ?? 0)) : 0
          const full = p >= 100
          const working = k.state === "working"
          return (
            <Pressable
              key={k.nodeId}
              accessibilityRole="button"
              accessibilityLabel={`${k.text}${isTask && k.state ? ` · ${t(`todo.state.${k.state}`)}` : ""}`}
              onPress={() => onOpen(k.nodeId)}
              style={({ hovered }: any) => [
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 34,
                  paddingHorizontal: 8,
                  marginLeft: -8,
                  marginRight: -8,
                  borderRadius: 10,
                  position: "relative",
                  backgroundColor: hovered ? td.wash2 : "transparent",
                },
                web({ cursor: "pointer", isolation: "isolate" }) as ViewStyle,
              ]}
            >
              {p > 0 && !full ? (
                <View
                  pointerEvents="none"
                  {...tdx(`kfill${full ? " full" : ""}`)}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: full ? "100%" : `${p}%`,
                    backgroundColor: k.state === "review" ? td.progRev : working ? td.progWorking : k.state === "pending" ? td.progPending : td.progBg,
                    borderRadius: 10,
                    zIndex: -1,
                  }}
                />
              ) : null}
              {isTask ? <Dot state={k.state} running={k.running} /> : <Ph name="folder-simple" size={14} color={td.text3} />}
              <Tx s={13} lh={18} c={k.state === "done" || k.state === "cancelled" ? td.doneTx : td.text} lines={1} style={{ flex: 1, minWidth: 0 }}>
                {k.text}
              </Tx>
              {isTask && k.state ? (
                <>
                  <Tx f="mono" s={10} lh={12} c={td.txs}>
                    {t(`todo.state.${k.state}`).toLowerCase()}
                  </Tx>
                  <Tx f="mono" s={10} lh={12} c={td.txs} style={{ minWidth: 30, textAlign: "right" }}>
                    {`${p} %`}
                  </Tx>
                </>
              ) : null}
            </Pressable>
          )
        })}
      </View>
      <View style={{ marginTop: 4 }}>
        {adding ? (
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={commit}
            onBlur={() => !draft.trim() && setAdding(false)}
            onKeyPress={(e: any) => e.nativeEvent.key === "Escape" && (setAdding(false), setDraft(""))}
            placeholder={isGroup ? t("todo.add.placeholder") : t("todo.add.child")}
            placeholderTextColor={td.text3}
            style={[
              { height: 30, borderRadius: 100, backgroundColor: td.card, paddingHorizontal: 12, fontFamily: F.sans, fontSize: 12.5, color: td.text, marginVertical: 2 },
              web({ outlineStyle: "none", boxShadow: "0 0 0 1px rgba(111,39,255,.3)" }) as TextStyle,
            ]}
          />
        ) : (
          <View style={{ alignSelf: "flex-start", marginLeft: -11 }}>
            <Btn sm tone="ghost" icon="plus" onPress={() => setAdding(true)}>
              {isGroup ? t("todo.task") : t("todo.childTask")}
            </Btn>
          </View>
        )}
      </View>
    </View>
  )
}
