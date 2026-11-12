/**
 * Form Manager — inline user forms.
 * docs/specs/20261024_non-blocking-user-interactions.md — non-blocking is THE path.
 *
 * `createAskFormCallback` registers the pending form and returns an immediate
 * `{ kind: 'displayed', formRequestId }` marker — the agent's turn ENDS. The
 * user's answer arrives later through `handleResponse` (submit / dismiss) or
 * a chat message (`resolvePendingInChannelAsAnsweredInChat`), which finalizes
 * into the channel: the tool_execution completes with the output, a synthetic
 * `form_response` user message lands in the channel and the agent wakes in a
 * NEW turn. This is the old restored-after-restart finalization generalized
 * from edge case to THE path.
 *
 * Pending forms are persisted in the tool_execution message — v2 forms live as
 * completed tool_executions whose output is still the `form_displayed` marker
 * (only overwritten on resolution), so they survive reloads and restarts.
 *
 * Content-driven by design: there is NO dedicated WS broadcast event — the
 * form spec travels in the tool call's `input` and the status flip reaches the
 * client via the existing `tool_status_update` chunk.
 *
 * Kept separate from permission-manager on purpose: that path is
 * security-sensitive and fail-closed; forms are plain UX.
 */

import type { Db } from "mongodb"
import { FormSpecSchema, FORM_TOOL_NAME, validateFormValues, type FormSpec } from "@teros/shared"
import { captureException } from "../../lib/sentry"
import {
  PendingFormsRegistry,
  type FormResolution,
  type PendingForm,
} from "./pending-forms-registry"
import type { UserFormResolution } from "../../services/mca-tool-executor"

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
  /**
   * v2: called when a pending form resolves WITHOUT the user's own message
   * already waking the agent (submit via widget, dismiss). Saves the synthetic
   * `form_response` user message into the channel and wakes the agent in a
   * NEW turn. Wired by MessageHandler.
   */
  onFormResolved?: (args: {
    channelId: string
    resolution: FormResolution
    formRequestId: string
    spec: FormSpec
  }) => Promise<void>
}

export function createFormManager(deps: FormManagerDeps) {
  const { broadcastToChannel, db, updateMessageContentFields, onFormResolved } = deps
  const registry = new PendingFormsRegistry()

  /** Persist the outcome into the tool_execution message + broadcast the
   * status flip. THE finalization: the values land in `output` so the agent
   * sees them in channel history on its next turn, and the UI card resolves. */
  async function finalizeFormMessage(
    pending: PendingForm,
    resolution: FormResolution,
  ): Promise<void> {
    if (!pending.messageId || !updateMessageContentFields) return
    const output =
      resolution.kind === "submitted"
        ? JSON.stringify({ submitted: true, values: resolution.values, notes: resolution.notes })
        : resolution.kind === "dismissed"
          ? JSON.stringify({ submitted: false, dismissed: true })
          : resolution.kind === "answered_in_chat"
            ? JSON.stringify({ submitted: false, answeredInChat: true })
            : JSON.stringify({ submitted: false, unavailable: true, reason: resolution.reason })
    await updateMessageContentFields(pending.messageId, {
      status: "completed",
      output,
      formRequestId: undefined,
    })
    // tool_call_complete (not a bare tool_status_update) so the client also
    // receives the output — otherwise its local copy keeps the stale
    // form_displayed marker and the widget stays live forever. The app's
    // tool_call_complete branch applies status+output and clears formRequestId.
    broadcastToChannel(pending.channelId, {
      type: "message_chunk",
      channelId: pending.channelId,
      messageId: pending.messageId,
      chunkType: "tool_call_complete",
      toolCallId: pending.toolCallId,
      toolStatus: "completed",
      toolOutput: output,
      timestamp: Date.now(),
    })
  }

  /** v2: finalize into the channel + wake via onFormResolved. Shared by every
   * resolution that does not ride on the user's own message. */
  async function finalizeIntoChannel(
    pending: PendingForm,
    resolution: FormResolution,
    formRequestId: string,
  ): Promise<void> {
    try {
      await finalizeFormMessage(pending, resolution)
    } catch (err) {
      console.error(`[FormManager] Failed to finalize form message:`, err)
    }
    if (onFormResolved) {
      try {
        await onFormResolved({
          channelId: pending.channelId,
          resolution,
          formRequestId,
          spec: pending.spec,
        })
      } catch (err) {
        console.error(`[FormManager] onFormResolved (wake) failed:`, err)
      }
    }
  }

  return {
    /**
     * Create the callback McaToolExecutor calls when the agent calls
     * request-user-input.
     *
     * Registers the pending form (status flip to pending_user_input exactly
     * as today) and returns an immediate `{ kind: 'displayed', formRequestId }`
     * marker — the executor turns it into the tool result and the agent ends
     * its turn. The answer arrives later via handleResponse.
     */
    createAskFormCallback(
      channelId: string,
      userId: string,
      getToolCallContext?: (toolCallId?: string) => FormToolCallContext | null,
      statusCallbacks?: FormStatusCallbacks,
    ) {
      return async (
        spec: FormSpec,
        toolCallId?: string,
      ): Promise<UserFormResolution | { kind: "displayed"; formRequestId: string }> => {
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
          return { kind: "unavailable", reason: "internal error resolving the chat anchor" }
        }

        // Without a messageId there is no inline UI anchor — the user would
        // never see the form and the turn would hang forever.
        if (getToolCallContext && (!context || !context.messageId)) {
          return {
            kind: "unavailable",
            reason: "the form could not be attached to a chat message",
          }
        }

        // One live form per channel. Stacked forms are confusing and the
        // frontend renders them per-message anyway.
        if (registry.hasPendingInChannel(channelId)) {
          return {
            kind: "unavailable",
            reason: "another form is already waiting for the user in this conversation",
          }
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
            }
          })
        }

        const capturedToolCallId = context?.toolCallId

        registry.register(formRequestId, {
          spec,
          channelId,
          messageId: context?.messageId,
          toolCallId: capturedToolCallId,
          userId,
          createdAt: Date.now(),
        })

        console.log(
          `[FormManager] Form request ${formRequestId} pending (msg: ${context?.messageId}, ${spec.fields.length} fields) — turn ends, answer arrives later`,
        )

        // The channel enters awaiting_user { kind: 'form', pointer } — the
        // unified frontend chip reads it (spec §Implementation design 5).
        broadcastToChannel(channelId, {
          type: "channel_status",
          channelId,
          awaitingUser: { kind: "form", pointer: formRequestId },
        })
        // The tool call is only "show the form". The executor turns this
        // marker into the tool result; the turn ends. handleResponse owns
        // everything that happens afterwards.
        return { kind: "displayed", formRequestId }
      }
    },

    /**
     * Handle the user's response from the client (`app.form-response`).
     * Validates submitted values against the pending spec server-side.
     * Returns null when the requestId is unknown; `{ idempotent: true }` on
     * duplicate responses; `{ errors }` when validation fails (form stays
     * pending so the user can correct it).
     *
     * Submit/dismiss ALWAYS finalize into the channel (tool_execution
     * output + synthetic form_response message + wake).
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

      // No live turn to unblock (the turn already ended when the form was
      // shown) — finalize into the channel + wake. Fire-and-forget: the wake
      // runs a full LLM turn, and awaiting it inside the WS request blows the
      // client's request timeout (the submit itself has already succeeded —
      // registry delete + recordResolved above).
      void finalizeIntoChannel(pending, resolution, formRequestId)

      return { channelId: pending.channelId }
    },

    /**
     * A free user message typed while a form is pending auto-resolves it
     * as `answered_in_chat` — the user's message always wins. Returns the
     * resolved formRequestId (the caller attaches it to the message as
     * `respondsTo`), or null when nothing is pending. Does NOT wake: the
     * user's own message already wakes the agent.
     */
    async resolvePendingInChannelAsAnsweredInChat(
      channelId: string,
    ): Promise<string | null> {
      for (const [formRequestId, pending] of registry.entries()) {
        if (pending.channelId !== channelId) continue
        const resolution: FormResolution = { kind: "answered_in_chat" }
        registry.delete(formRequestId)
        registry.recordResolved(formRequestId, resolution)
        console.log(`[FormManager] Form ${formRequestId} auto-resolved as answered_in_chat`)
        try {
          await finalizeFormMessage(pending, resolution)
        } catch (err) {
          console.error(`[FormManager] Failed to finalize answered_in_chat form:`, err)
        }
        // No wake here — the user's message itself wakes the agent.
        return formRequestId
      }
      return null
    },

    /**
     * Restore pending forms for a channel after a backend restart or page
     * reload. Live forms exist as completed tool_executions whose output is
     * still the form_displayed marker (the marker is only overwritten by
     * finalizeFormMessage on resolution) — re-register them so submits land
     * and re-broadcast awaiting_user to rehydrate the chip. Mirrors
     * restorePendingApprovals; called on channel subscribe.
     */
    async restorePendingForms(channelId: string): Promise<number> {
      if (!db) return 0

      // v2 forms live as completed tool_executions whose output is still the
      // form_displayed marker — the marker is only overwritten by
      // finalizeFormMessage when the form resolves, so "completed + marker
      // output" means "still waiting for the user".
      let restored = 0
      const messages = await db
        .collection("channel_messages")
        .find({
          channelId,
          "content.type": "tool_execution",
          "content.status": "completed",
          "content.toolName": FORM_TOOL_NAME,
        })
        .toArray()
      for (const message of messages) {
        const content = message.content as Record<string, any>
        try {
          const marker = content.output ? JSON.parse(content.output) : null
          if (
            !marker ||
            marker.status !== "form_displayed" ||
            typeof marker.formRequestId !== "string" ||
            registry.has(marker.formRequestId)
          ) {
            continue
          }
          const parsedSpec = FormSpecSchema.safeParse(content.input)
          if (!parsedSpec.success) continue
          registry.register(marker.formRequestId, {
            spec: parsedSpec.data,
            channelId,
            messageId: message.messageId,
            toolCallId: content.toolCallId,
            restored: true,
            createdAt: Date.now(),
          })
          restored++
        } catch {
          continue // corrupt output — not a live marker
        }
      }

      if (restored > 0) {
        console.log(
          `[FormManager] Restored ${restored} pending form(s) for channel ${channelId}`,
        )
        // Rehydrate the awaiting_user chip: the channel_status broadcast is
        // transient, so a reload (or restart) leaves the frontend without it
        // until the next enter/clear event. The first restored form is the
        // channel's pending form (one live form per channel).
        for (const [rid, p] of registry.entries()) {
          if (p.channelId === channelId) {
            broadcastToChannel(channelId, {
              type: "channel_status",
              channelId,
              awaitingUser: { kind: "form", pointer: rid },
            })
            break
          }
        }
      }
      return restored
    },

    getPendingCount(): number {
      return registry.size()
    },

    /**
     * True if any form is still pending in this channel — used by the
     * message-handler to compute the channel's awaiting_user state.
     */
    hasPendingInChannel(channelId: string): boolean {
      return registry.hasPendingInChannel(channelId)
    },

    /**
     * Resolve every pending form as unavailable (process shutdown /
     * teardown) so a late response gets the idempotent no-op path.
     */
    clearAll(): void {
      const ids = [...registry.entries()].map(([id]) => id)
      for (const formRequestId of ids) {
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
