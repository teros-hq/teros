/**
 * Awaitable input-Sheet flow for the MCA Health dashboard (Task 2, plan 05 / TEST-01/02). Owns the
 * input-form Sheet state and the Retest press path: resolve the tool schema, then either run
 * immediately (no required inputs) or open the Sheet and PARK a resolver so the whole-MCA loop can
 * `await onRetestPress` per tool — the promise stays pending until Submit (runs the tool, then
 * resolves) or Cancel (resolves WITHOUT running, skipping the tool). Split from `useMcaHealthRunner`
 * so the Sheet serialization is its own cohesive slice under the CLAUDE.md line/complexity limits.
 *
 * Sheet-open decision (`onRetestPress`): gate on `required.length`, NOT `requiresInput`
 * (properties-count) — a malformed schema with a non-empty `required` but empty `properties` would
 * otherwise run the tool with `{}`. If schemas can't be fetched, fall back to a zero-input run (D-04).
 * A Sheet already parked is never clobbered (would strand the first loop's resolver) — the request
 * is skipped. Non-flat tools seed the raw-JSON editor with the schema shape so required fields are
 * visible, never an empty box that Submits as `{}` (→ opaque MCA crash).
 *
 * `submitForm` builds the input via `buildFormInput` (null → parse error or missing required field,
 * Sheet stays open), detaches the parked resolver up-front so `closeForm` can't re-fire it before
 * the tool runs, runs the tool EXACTLY once, then resolves to unblock the whole-MCA loop.
 */
import { useCallback, useRef, useState } from "react"
import type { McaResolvability, McaToolSchema } from "../../services/AppApi"
import {
  type ActiveForm,
  buildFormInput,
  initialRawJson,
  toolNeedsInput,
} from "./mcaHealth.utils"

export interface McaFormFlow {
  activeForm: ActiveForm | null
  formValues: Record<string, unknown>
  setFormValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
  rawJson: string
  setRawJson: (v: string) => void
  /** Resolve schema then run immediately, or open the awaitable Sheet for input-requiring tools. */
  onRetestPress: (mcaId: string, tool: string) => Promise<void>
  /** Close WITHOUT running (Cancel / X / dismiss); resolves the parked promise so the loop advances. */
  closeForm: () => void
  /** Build input from the form, run the tool EXACTLY once, then resolve the parked promise. */
  submitForm: () => Promise<void>
}

/**
 * Resolve one tool's schema, swallowing a fetch failure. A failed fetch and an unmatched tool both
 * return undefined → `onRetestPress` falls back to the same zero-input run (D-04).
 */
async function findToolSchema(
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>,
  mcaId: string,
  tool: string,
): Promise<McaToolSchema | undefined> {
  try {
    return (await ensureSchemas(mcaId)).find((s) => s.tool === tool)
  } catch {
    return undefined
  }
}

export function useMcaFormFlow(
  runSingleTool: (mcaId: string, tool: string, input?: Record<string, unknown>) => Promise<void>,
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>,
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>,
): McaFormFlow {
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null)
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [rawJson, setRawJson] = useState("")
  const formResolveRef = useRef<(() => void) | null>(null)

  const onRetestPress = useCallback(
    async (mcaId: string, tool: string) => {
      await ensureResolvability(mcaId)
      const schema = await findToolSchema(ensureSchemas, mcaId, tool)
      if (!schema || !toolNeedsInput(schema)) {
        await runSingleTool(mcaId, tool)
        return
      }
      if (formResolveRef.current) return
      return new Promise<void>((resolve) => {
        setFormValues({})
        setRawJson(initialRawJson(schema.inputSchema))
        setActiveForm({ mcaId, tool, schema })
        formResolveRef.current = resolve
      })
    },
    [ensureResolvability, ensureSchemas, runSingleTool],
  )

  const closeForm = useCallback(() => {
    setActiveForm(null)
    setFormValues({})
    setRawJson("")
    const resolve = formResolveRef.current
    formResolveRef.current = null
    resolve?.()
  }, [])

  const submitForm = useCallback(async () => {
    if (!activeForm) return
    const { mcaId, tool, schema } = activeForm
    const input = buildFormInput(schema.inputSchema, formValues, rawJson)
    if (input === null) return
    const resolve = formResolveRef.current
    formResolveRef.current = null
    closeForm()
    await runSingleTool(mcaId, tool, input)
    resolve?.()
  }, [activeForm, formValues, rawJson, closeForm, runSingleTool])

  return {
    activeForm,
    formValues,
    setFormValues,
    rawJson,
    setRawJson,
    onRetestPress,
    closeForm,
    submitForm,
  }
}
