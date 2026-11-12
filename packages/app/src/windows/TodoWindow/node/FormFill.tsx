/**
 * A form output as the working surface (TODOAP-REQ-16): every field rendered
 * as its input with the chat form's FieldControl, editable in place;
 * checkboxes tick in place as a checklist. Each change is applied locally at
 * once (`onPatch`, so the tab's done/total moves) and saved debounced
 * (`onSave`, full fields + values through set-output). Never touches the
 * task state.
 */
import type { FormField } from "@teros/shared"
import React, { useEffect, useRef, useState } from "react"
import { View, type ViewStyle } from "react-native"
import { coerceValues, FieldControl, type RawValues } from "../../../components/mca/FormWidget"
import type { NodeIO } from "../model/types"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

type FormIO = Extract<NodeIO, { format: "form" }>
const SAVE_MS = 500

function toRaw(fields: FormField[], values: Record<string, unknown> | undefined): RawValues {
  const raw: RawValues = {}
  for (const f of fields) {
    const v = values?.[f.id]
    raw[f.id] = f.type === "checkbox" ? v === true : v == null ? "" : String(v)
  }
  return raw
}

/** @spec TODOAP-REQ-16 */
export function FormFill({
  io,
  onPatch,
  onSave,
}: {
  io: FormIO
  onPatch: (output: FormIO) => void
  onSave: (output: FormIO) => void
}) {
  const td = useTd()
  const fields = io.fields as unknown as FormField[]
  const fieldsKey = JSON.stringify(fields)
  const [raw, setRaw] = useState<RawValues>(() => toRaw(fields, io.values))
  const pending = useRef<FormIO | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  // Other fields (a new definition, another writer replacing the form) reset the inputs.
  useEffect(() => {
    setRaw(toRaw(fields, io.values))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey])

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (pending.current) saveRef.current(pending.current)
    pending.current = null
  }
  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (id: string, value: string | boolean) => {
    const next = { ...raw, [id]: value }
    setRaw(next)
    const output: FormIO = { format: "form", fields: io.fields, values: coerceValues({ fields }, next) }
    onPatch(output)
    pending.current = output
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_MS)
  }

  return (
    <View
      testID="todo-form-fill"
      style={[
        { backgroundColor: td.card, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 16, gap: 14, minWidth: 0 },
        web({ boxShadow: td.cardShadow }) as ViewStyle,
      ]}
    >
      {fields.map((f) => (
        <View key={f.id} testID={`todo-form-field-${f.id}`} style={{ minWidth: 0 }}>
          <FieldControl field={f} value={raw[f.id]} disabled={false} onChange={(v) => change(f.id, v)} />
        </View>
      ))}
    </View>
  )
}
