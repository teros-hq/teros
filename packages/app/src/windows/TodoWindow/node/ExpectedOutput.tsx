/**
 * Expected output definition (TODOAP-REQ-14), shown in the Output tab.
 *
 * While the task has no output: the editor — format chips, a one-line
 * description, the file type pills for `file`, a compact field editor
 * (name, type, required) for `form`. Text edits save debounced and on blur,
 * choices save at once; "Clear" sets the definition to null.
 * Once an output exists: a read-only one-line summary.
 *
 * Field ids follow the `@teros/shared` FormField rule
 * (`^[a-zA-Z][a-zA-Z0-9_-]*$`): a field keeps the id it came with until its
 * name is edited, then the id is derived from the name.
 */
import type { FormField } from "@teros/shared"
import type { TFunction } from "i18next"
import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { EXPECTED_FILE_TYPES, type ExpectedFileType, type ExpectedOutput, type OutputFormat } from "../model/types"
import { Eyebrow, Field, FilterChip, IconBtn, Lnk, MenuBox, MenuItem, Tx, useDismiss } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

const FORMATS: OutputFormat[] = ["markdown", "form", "file"]
/** Field types the compact editor offers (select / radio need options it does not edit). */
const FIELD_TYPES = ["text", "textarea", "number", "checkbox", "date", "time", "datetime"] as const
type FieldType = FormField["type"]

const DESCRIPTION_MAX = 500
const DEBOUNCE_MS = 600

interface Row {
  key: number
  /** The id the field came with; dropped once its name is edited. */
  id?: string
  label: string
  type: FieldType
  required: boolean
  /** The rest of an incoming field (options, placeholder…), kept while its type is unchanged. */
  extra: Record<string, unknown>
}

interface Draft {
  format: OutputFormat | null
  description: string
  fileType: ExpectedFileType | null
  rows: Row[]
}

let rowSeq = 0

function toDraft(def: ExpectedOutput | null | undefined): Draft {
  return {
    format: def?.format ?? null,
    description: def?.description ?? "",
    fileType: def?.fileType ?? null,
    rows: (def?.fields ?? []).map((f) => {
      const { id, label, type, required, ...extra } = f as FormField & Record<string, unknown>
      return { key: ++rowSeq, id, label, type, required: !!required, extra }
    }),
  }
}

/** A FormField id from a field name, unique among `taken`. */
export function fieldIdFor(label: string, taken: Set<string>): string {
  let base = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!base) base = "field"
  if (!/^[a-z]/.test(base)) base = `f_${base}`
  base = base.slice(0, 60)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`
  return id
}

/** The definition a draft stands for (null when no format is chosen). */
export function draftToDefinition(d: Draft): ExpectedOutput | null {
  if (!d.format) return null
  const def: ExpectedOutput = { format: d.format }
  const description = d.description.trim()
  if (description) def.description = description.slice(0, DESCRIPTION_MAX)
  if (d.format === "file" && d.fileType) def.fileType = d.fileType
  if (d.format === "form") {
    const taken = new Set<string>()
    const fields = d.rows
      .filter((r) => r.label.trim())
      .map((r) => {
        const id = r.id && !taken.has(r.id) ? r.id : fieldIdFor(r.label.trim(), taken)
        taken.add(id)
        return { ...r.extra, id, label: r.label.trim(), type: r.type, ...(r.required ? { required: true } : {}) } as FormField
      })
    if (fields.length) def.fields = fields
  }
  return def
}

function same(a: ExpectedOutput | null | undefined, b: ExpectedOutput | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function fileTypeLabel(ft: ExpectedFileType, t: TFunction): string {
  return ft === "other" ? t("todo.expected.other") : ft.toUpperCase()
}

/** "Expected: file · PDF · Invoice with tax id…" / "Expected: form · 3 fields" — human words, not the enum. */
export function expectedSummary(def: ExpectedOutput, t: TFunction): string {
  const parts = [t(`todo.expected.what.${def.format}`)]
  if (def.format === "file" && def.fileType) parts.push(fileTypeLabel(def.fileType, t))
  if (def.format === "form" && def.fields?.length) parts.push(t("todo.expected.fieldCount", { count: def.fields.length }))
  if (def.description) parts.push(def.description)
  return t("todo.expected.summary", { what: parts.join(" · ") })
}

function SubLabel({ children }: { children: string }) {
  const td = useTd()
  return (
    <Tx f="mono" s={9.5} lh={12} c={td.txs} ls={0.3} upper style={{ marginTop: 14, marginBottom: 8 }}>
      {children}
    </Tx>
  )
}

/** Read-only one-line summary in the output's header once the task has an output. @spec TODOAP-REQ-14 */
export function ExpectedOutputSummary({ value }: { value: ExpectedOutput }) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <View testID="todo-expected-summary" style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 1 }}>
      <Ph name="target" size={14} color={td.text3} />
      <Tx s={12.5} lh={17} c={td.text2} lines={1} style={{ flexShrink: 1 }}>
        {expectedSummary(value, t)}
      </Tx>
    </View>
  )
}

function TypePicker({ value, onChange }: { value: FieldType; onChange: (v: FieldType) => void }) {
  const td = useTd()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<View>(null)
  const btn = useRef<View>(null)
  useDismiss(open, () => setOpen(false), ref, btn)
  return (
    <View style={{ position: "relative", flexShrink: 0 }}>
      <Pressable
        ref={btn}
        testID="todo-expected-field-type"
        accessibilityRole="button"
        accessibilityLabel={t("todo.expected.fieldType")}
        onPress={() => setOpen((o) => !o)}
        style={({ hovered }: any) => [
          { height: 32, width: 104, paddingHorizontal: 11, borderRadius: 100, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, backgroundColor: hovered || open ? td.wash2 : "transparent" },
          web({ cursor: "pointer", boxShadow: `0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
        ]}
      >
        <Tx s={11.5} lh={14} c={td.text2} lines={1} style={{ flexShrink: 1 }}>
          {t(`todo.expected.types.${value}`)}
        </Tx>
        <Ph name="caret-down" size={10} color={td.text3} />
      </Pressable>
      {open ? (
        <MenuBox ref={ref} right minWidth={150} label={t("todo.expected.fieldType")}>
          {FIELD_TYPES.map((ft) => (
            <MenuItem
              key={ft}
              label={t(`todo.expected.types.${ft}`)}
              checked={ft === value}
              onPress={() => {
                setOpen(false)
                onChange(ft)
              }}
            />
          ))}
        </MenuBox>
      ) : null}
    </View>
  )
}

/** The definition editor while the task has no output. @spec TODOAP-REQ-14 */
export function ExpectedOutputEditor({
  value,
  onChange,
}: {
  value: ExpectedOutput | null | undefined
  onChange: (def: ExpectedOutput | null) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(() => toDraft(value))
  const sent = useRef<ExpectedOutput | null>(value ?? null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(draft)
  latest.current = draft
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // A definition changed elsewhere (another window, the agent) replaces the draft.
  useEffect(() => {
    if (same(value, sent.current)) return
    sent.current = value ?? null
    setDraft(toDraft(value))
  }, [value])

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const def = draftToDefinition(latest.current)
    if (same(def, sent.current)) return
    sent.current = def
    onChangeRef.current(def)
  }

  // Unsaved text is saved when the tab goes away.
  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Apply a change; `now` saves at once, otherwise debounced. */
  const edit = (fn: (d: Draft) => Draft, now: boolean) => {
    const next = fn(latest.current)
    latest.current = next
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    if (now) flush()
    else timer.current = setTimeout(flush, DEBOUNCE_MS)
  }

  const setRow = (key: number, fn: (r: Row) => Row, now: boolean) =>
    edit((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? fn(r) : r)) }), now)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const empty = toDraft(null)
    latest.current = empty
    setDraft(empty)
    sent.current = null
    onChange(null)
  }

  return (
    <View testID="todo-expected">
      <Eyebrow
        right={
          draft.format ? (
            <View style={{ marginRight: -9 }}>
              <Lnk onPress={clear}>{t("todo.expected.clear")}</Lnk>
            </View>
          ) : null
        }
      >
        {t("todo.expected.title")}
      </Eyebrow>
      <View
        testID="todo-output-format"
        accessibilityRole="radiogroup"
        accessibilityLabel={t("todo.expected.label")}
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, marginLeft: -2 }}
      >
        {FORMATS.map((f) => (
          <FilterChip key={f} on={draft.format === f} onPress={() => edit((d) => ({ ...d, format: f }), true)} label={t(`todo.expected.${f}`)} />
        ))}
      </View>
      {draft.format ? (
        <>
          <Field
            testID="todo-expected-description"
            accessibilityLabel={t("todo.expected.descriptionLabel")}
            placeholder={t("todo.expected.descriptionPlaceholder")}
            value={draft.description}
            maxLength={DESCRIPTION_MAX}
            onChangeText={(description) => edit((d) => ({ ...d, description }), false)}
            onBlur={flush}
            onSubmitEditing={flush}
            style={{ marginTop: 10, alignSelf: "stretch" }}
          />
          {draft.format === "file" ? (
            <>
              <SubLabel>{t("todo.expected.fileType")}</SubLabel>
              <View
                testID="todo-expected-filetype"
                accessibilityRole="radiogroup"
                accessibilityLabel={t("todo.expected.fileType")}
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginLeft: -2 }}
              >
                {EXPECTED_FILE_TYPES.map((ft) => (
                  <FilterChip
                    key={ft}
                    height={24}
                    on={draft.fileType === ft}
                    onPress={() => edit((d) => ({ ...d, fileType: d.fileType === ft ? null : ft }), true)}
                    label={fileTypeLabel(ft, t)}
                  />
                ))}
              </View>
            </>
          ) : null}
          {draft.format === "form" ? (
            <View testID="todo-expected-fields">
              <SubLabel>{t("todo.expected.fields")}</SubLabel>
              <View style={{ gap: 6 }}>
                {draft.rows.map((r, i) => (
                  <View
                    key={r.key}
                    testID="todo-expected-field"
                    style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, zIndex: draft.rows.length - i }}
                  >
                    <Field
                      testID="todo-expected-field-name"
                      accessibilityLabel={t("todo.expected.fieldName")}
                      placeholder={t("todo.expected.fieldName")}
                      value={r.label}
                      maxLength={200}
                      onChangeText={(label) => setRow(r.key, (x) => ({ ...x, label, id: undefined }), false)}
                      onBlur={flush}
                      onSubmitEditing={flush}
                      style={{ flex: 1 }}
                    />
                    <TypePicker value={r.type} onChange={(type) => setRow(r.key, (x) => (x.type === type ? x : { ...x, type, extra: {} }), true)} />
                    <FilterChip
                      height={32}
                      on={r.required}
                      onPress={() => setRow(r.key, (x) => ({ ...x, required: !x.required }), true)}
                      label={t("todo.expected.required")}
                    />
                    <IconBtn
                      icon="x"
                      size={28}
                      iconSize={13}
                      label={t("todo.expected.removeField", { name: r.label })}
                      onPress={() => edit((d) => ({ ...d, rows: d.rows.filter((x) => x.key !== r.key) }), true)}
                    />
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: "row", marginTop: draft.rows.length ? 8 : 0, marginLeft: -9 }}>
                <Lnk
                  icon="plus"
                  onPress={() =>
                    setDraft((d) => {
                      const next = { ...d, rows: [...d.rows, { key: ++rowSeq, label: "", type: "text" as FieldType, required: false, extra: {} }] }
                      latest.current = next
                      return next
                    })
                  }
                >
                  {t("todo.expected.addField")}
                </Lnk>
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  )
}
