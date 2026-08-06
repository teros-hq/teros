/**
 * Form Manager — inline user forms.
 *
 * Mirrors the permission-manager shape: the built-in `request-user-input` tool
 * blocks on a Promise held here; the user's submit (or dismiss) resolves it and
 * the answers become the tool result. Pending forms are persisted in the
 * tool_execution message (`status: 'pending_user_input'` + `formRequestId`) so
 * they can be restored after a page reload or a backend restart.
 *
 * Content-driven by design: there is NO dedicated WS broadcast event — the form
 * spec travels in the tool call's `input` (persisted at tool_call_start) and
 * the status flip reaches the client via the existing `tool_status_update`
 * chunk, so no forwardEvents whitelist change is needed on the frontend.
 *
 * Kept separate from permission-manager on purpose: that path is
 * security-sensitive and fail-closed; forms are plain UX.
 */

import type { Db } from "mongodb"
import { FormSpecSchema, validateFormValues, type FormSpec } from "@teros/shared"
import { captureException } from "../../lib/sentry"
import {
  PendingFormsRegistry,
  type FormResolution,
  type PendingForm,
} from "./pending-forms-registry"

export type { FormResolution, PendingForm }

/** Same shape as permission-manager's ToolCallContext (see its TER-267 note). */
export interface FormToolCallContext {
  messageId?: string
  toolCallId: string
  toolName?: string
}

/** Callbacks for tool status updates during the form flow. */
export interface FormStatusCallbacks {
  /** Called when the tool enters pending_user_input state. */
  onPendingForm?: (
    formRequestId: string,
    spec: FormSpec,
    toolCallId?: string,
  ) => Promise<void>
  /** Called when the form was submitted and the tool is about to resume. */
  onFormSubmitted?: (toolCallId?: string) => Promise<void>
}

/** What the client sends back via `app.form-response`. */
export interface FormResponsePayload {
  values?: unknown
  notes?: string
  dismissed?: boolean
}

function generateFormRequestId(): string {
  return `form_${crypto.randomUUID()}`
}

export interface FormManagerDeps {
  broadcastToChannel: (channelId: string, message: any) => void
  /** Database for restore-after-restart. */
  db?: Db
  /** Field-level content update (channelManager.updateMessageContentFields). */
  updateMessageContentFields?: (
    messageId: string,
    fields: Record<string, unknown>,
  ) => Promise<void>
}

export function createFormManager(deps: FormManagerDeps) {
  const { broadcastToChannel, db, updateMessageContentFields } = deps
  const registry = new PendingFormsRegistry()

  /** Persist resolution + broadcast for forms whose original turn is gone
   * (restored after a backend restart). The submitted values land in `output`
   * so the agent sees them in channel history on its next turn. */
  async function finalizeRestoredForm(
    pending: PendingForm,
    resolution: FormResolution,
  ): Promise<void> {
    if (!pending.messageId || !updateMessageContentFields) return
    const output =
      resolution.kind === "submitted"
        ? JSON.stringify({ submitted: true, values: resolution.values, notes: resolution.notes })
        : JSON.stringify({ submitted: false, dismissed: true })
    await updateMessageContentFields(pending.messageId, {
      status: "completed",
      output,
      formRequestId: undefined,
    })
    broadcastToChannel(pending.channelId, {
      type: "message_chunk",
      channelId: pending.channelId,
      messageId: pending.messageId,
      chunkType: "tool_status_update",
      toolCallId: pending.toolCallId,
      toolStatus: "completed",
      timestamp: Date.now(),
    })
  }

  return {
    /**
     * Create the callback McaToolExecutor awaits when the agent calls
     * request-user-input. Mirrors createAskPermissionCallback.
     */
    createAskFormCallback(
      channelId: string,
      userId: string,
      getToolCallContext?: (toolCallId?: string) => FormToolCallContext | null,
      statusCallbacks?: FormStatusCallbacks,
    ) {
      return async (spec: FormSpec, toolCallId?: string): Promise<FormResolution> => {
        return new Promise((resolve, reject) => {
          const formRequestId = generateFormRequestId()

          let context: FormToolCallContext | null = null
          try {
            context = getToolCallContext?.(toolCallId) ?? null
          } catch (err) {
            console.error(`[FormManager] getToolCallContext threw`, {
              channelId,
              toolCallId,
              err,
            })
            captureException(
              err as Error,
              { context: "form.getToolCallContext", toolCallId },
              { userId, channelId },
            )
            resolve({ kind: "unavailable", reason: "internal error resolving the chat anchor" })
            return
          }

          // Without a messageId there is no inline UI anchor — the user would
          // never see the form and the turn would hang forever.
          if (getToolCallContext && (!context || !context.messageId)) {
            resolve({
              kind: "unavailable",
              reason: "the form could not be attached to a chat message",
            })
            return
          }

          // v1 rule: one live form per channel. Stacked forms are confusing and
          // the frontend renders them per-message anyway.
          if (registry.hasPendingInChannel(channelId)) {
            resolve({
              kind: "unavailable",
              reason: "another form is already waiting for the user in this conversation",
            })
            return
          }

          // Flip the tool to pending_user_input (persist + broadcast chunk).
          // If this fails the user never sees the form — clean up and resolve
          // unavailable instead of hanging (same defense as permissions).
          const pendingPromise = statusCallbacks?.onPendingForm?.(
            formRequestId,
            spec,
            context?.toolCallId,
          )
          if (pendingPromise) {
            pendingPromise.catch((err) => {
              console.error(
                "[FormManager] onPendingForm failed — cleaning up and resolving unavailable",
                { formRequestId, channelId, toolCallId, err },
              )
              const stillPending = registry.get(formRequestId)
              if (stillPending) {
                registry.delete(formRequestId)
                registry.recordResolved(formRequestId, {
                  kind: "unavailable",
                  reason: "failed to render the form",
                })
                stillPending.resolve({
                  kind: "unavailable",
                  reason: "failed to render the form",
                })
              }
            })
          }

          const capturedToolCallId = context?.toolCallId

          registry.register(formRequestId, {
            resolve: (resolution: FormResolution) => {
              // On submit, flip the tool to running before resuming — mirrors
              // onPermissionGranted so the widget disappears immediately.
              if (resolution.kind === "submitted" && statusCallbacks?.onFormSubmitted) {
                statusCallbacks
                  .onFormSubmitted(capturedToolCallId)
                  .then(() => resolve(resolution))
                  .catch((err) => {
                    console.error("[FormManager] onFormSubmitted failed:", err)
                    resolve(resolution)
                  })
              } else {
                resolve(resolution)
              }
            },
            reject,
            spec,
            channelId,
            messageId: context?.messageId,
            toolCallId: capturedToolCallId,
            userId,
            createdAt: Date.now(),
          })

          console.log(
            `[FormManager] Form request ${formRequestId} pending (msg: ${context?.messageId}, ${spec.fields.length} fields) — waiting for user`,
          )
        })
      }
    },

    /**
     * Handle the user's response from the client (`app.form-response`).
     * Validates submitted values against the pending spec server-side.
     * Returns null when the requestId is unknown; `{ idempotent: true }` on
     * duplicate responses; `{ errors }` when validation fails (form stays
     * pending so the user can correct it).
     */
    async handleResponse(
      formRequestId: string,
      payload: FormResponsePayload,
    ): Promise<
      | { channelId: string; idempotent?: boolean; errors?: string[] }
      | null
    > {
      const pending = registry.get(formRequestId)
      if (!pending) {
        const prior = registry.getResolved(formRequestId)
        if (prior) {
          console.log(
            `[FormManager] handleResponse for already-resolved form ${formRequestId} — idempotent no-op`,
          )
          return { channelId: "", idempotent: true }
        }
        console.warn(`[FormManager] No pending form found: ${formRequestId}`)
        return null
      }

      let resolution: FormResolution
      if (payload.dismissed) {
        resolution = { kind: "dismissed" }
      } else {
        // SERVER-SIDE validation against the persisted spec — never trust the
        // client payload. On failure the form STAYS pending: the client shows
        // the errors and the user can correct and resubmit.
        const result = validateFormValues(pending.spec, payload.values)
        if (!result.ok) {
          console.warn(`[FormManager] Invalid submission for ${formRequestId}:`, result.errors)
          return { channelId: pending.channelId, errors: result.errors }
        }
        const notes =
          typeof payload.notes === "string" ? payload.notes.trim().slice(0, 4000) : undefined
        resolution = { kind: "submitted", values: result.values, notes: notes || undefined }
      }

      registry.delete(formRequestId)
      registry.recordResolved(formRequestId, resolution)

      console.log(`[FormManager] Form ${formRequestId} resolved: ${resolution.kind}`)

      if (pending.restored) {
        // The original turn died with the backend — persist the outcome into
        // the message so the agent sees it in history on its next turn.
        // (Open decision in the spec: v2 may wake the agent with the values.)
        try {
          await finalizeRestoredForm(pending, resolution)
        } catch (err) {
          console.error(`[FormManager] Failed to finalize restored form:`, err)
        }
      } else {
        pending.resolve(resolution)
      }

      return { channelId: pending.channelId }
    },

    /**
     * Restore pending forms for a channel after a backend restart. Re-registers
     * them (restored: true) so a submit still lands somewhere. Mirrors
     * restorePendingApprovals; called on channel subscribe.
     */
    async restorePendingForms(channelId: string): Promise<number> {
      if (!db) return 0
      const messages = await db
        .collection("channel_messages")
        .find({
          channelId,
          "content.type": "tool_execution",
          "content.status": "pending_user_input",
          "content.formRequestId": { $exists: true },
        })
        .toArray()

      let restored = 0
      for (const message of messages) {
        const content = message.content as Record<string, any>
        const formRequestId = content.formRequestId as string
        if (registry.has(formRequestId)) continue // in-memory pending survived (reload, not restart)

        // The spec is the tool call's input; validate it before trusting it.
        const parsed = FormSpecSchema.safeParse(content.input)
        if (!parsed.success) {
          console.warn(
            `[FormManager] Skipping restore of ${formRequestId} — persisted spec no longer parses`,
          )
          if (updateMessageContentFields) {
            await updateMessageContentFields(message.messageId, {
              status: "failed",
              error: "Form could not be restored after a backend restart",
              formRequestId: undefined,
            }).catch(() => {})
          }
          continue
        }

        registry.register(formRequestId, {
          resolve: () => {}, // no live turn — finalizeRestoredForm handles the outcome
          reject: () => {},
          spec: parsed.data,
          channelId,
          messageId: message.messageId,
          toolCallId: content.toolCallId,
          restored: true,
          createdAt: Date.now(),
        })
        restored++
      }

      if (restored > 0) {
        console.log(`[FormManager] Restored ${restored} pending form(s) for channel ${channelId}`)
      }
      return restored
    },

    getPendingCount(): number {
      return registry.size()
    },

    /**
     * Resolve every non-restored pending form as unavailable (process
     * shutdown / teardown) so no tool call is left hanging.
     */
    clearAll(): void {
      const ids = [...registry.entries()].map(([id]) => id)
      for (const formRequestId of ids) {
        const pending = registry.get(formRequestId)
        if (!pending) continue
        if (!pending.restored) {
          pending.resolve({ kind: "unavailable", reason: "the conversation was shut down" })
        }
        registry.delete(formRequestId)
        // Keep the resolved record (NOT registry.clear(), which would wipe it)
        // so a response racing the shutdown gets the idempotent no-op path.
        registry.recordResolved(formRequestId, {
          kind: "unavailable",
          reason: "the conversation was shut down",
        })
      }
    },
  }
}

export type FormManager = ReturnType<typeof createFormManager>
