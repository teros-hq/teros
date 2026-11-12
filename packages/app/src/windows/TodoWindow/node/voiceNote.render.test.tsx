/**
 * To Do — voice notes in the reply and send-back boxes
 * (docs/specs/todo/autoplay/spec.md, TODOAP-REQ-26 / TODOAP-AC-37; Pablo,
 * 2026-10-30: the control behaves exactly like the chat composer's).
 * The microphone, RecordRTC (the engine jsdom's non-Safari user agent picks),
 * the todo-list tool path and the client's transcription are stubbed.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/voiceNote
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { NodeDetail } from "../model/types"

const h = vi.hoisted(() => {
  const state = { nodes: {} as Record<string, Record<string, unknown>> }
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  const transcribe = { impl: async (_d: string, _m?: string): Promise<{ text: string }> => ({ text: "" }), calls: [] as Array<[string, string | undefined]> }
  const tracks: Array<{ stop: () => void; stopped: boolean }> = []
  const recorders: Array<{ options: Record<string, unknown> }> = []
  const client = {
    on: () => {},
    off: () => {},
    app: { subscribeTodo: async () => ({ userId: "u1" }) },
    workspace: { listMembers: async () => ({ members: [] }) },
    channel: {
      transcribeAudio: (d: string, m?: string) => {
        transcribe.calls.push([d, m])
        return transcribe.impl(d, m)
      },
    },
  }
  const callTodo = async (_appId: string, tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input })
    const n = state.nodes[input.nodeId as string]
    if (tool === "get-node") return { node: n }
    if (tool === "get-tree") return { tree: [] }
    if (tool === "set-state" && n) n.state = input.state
    return {}
  }
  return { client, state, calls, callTodo, transcribe, tracks, recorders }
})

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))
vi.mock("../data/todoApi", () => ({
  callTodo: (...a: [string, string, Record<string, unknown>]) => h.callTodo(...a),
  TodoError: class extends Error {},
}))
vi.mock("recordrtc", () => {
  class RecordRTC {
    options: Record<string, unknown>
    constructor(_stream: unknown, options: Record<string, unknown>) {
      this.options = options
      h.recorders.push(this)
    }
    startRecording() {}
    stopRecording(cb: () => void) {
      cb()
    }
    getBlob() {
      return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" })
    }
  }
  return { default: RecordRTC, StereoAudioRecorder: class {} }
})

// jsdom has neither URL.createObjectURL nor revokeObjectURL — the stopped
// take needs a playback URL and the teardown revokes it.
beforeEach(() => {
  if (typeof URL.createObjectURL !== "function") {
    ;(URL as unknown as { __mockedCreate?: boolean }).__mockedCreate = true
    URL.createObjectURL = (() => "blob:mock") as typeof URL.createObjectURL
  }
  if (typeof URL.revokeObjectURL !== "function") {
    ;(URL as unknown as { __mockedRevoke?: boolean }).__mockedRevoke = true
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  }
})
afterEach(() => {
  if ((URL as unknown as { __mockedCreate?: boolean }).__mockedCreate) {
    ;(URL as unknown as Record<string, unknown>).createObjectURL = undefined
    delete (URL as unknown as { __mockedCreate?: boolean }).__mockedCreate
  }
  if ((URL as unknown as { __mockedRevoke?: boolean }).__mockedRevoke) {
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = undefined
    delete (URL as unknown as { __mockedRevoke?: boolean }).__mockedRevoke
  }
})

function node(id: string, state: "review" | "blocked"): NodeDetail {
  return {
    nodeId: id, parentId: null, text: "Landing de precios", description: "", instructions: "", kind: "task", state,
    blockedReason: state === "blocked" ? "Which VAT rate?" : null, allowedTransitions: [], progress: null, reportedProgress: null,
    input: null, output: { format: "markdown", markdown: "# Done" }, hasInput: false, hasOutput: true, plannedFor: null, dayOrder: null,
    plannedTime: null, assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0,
    log: [], createdAt: 0, updatedAt: 0,
  }
}

const SEND_BACK = "What is missing or wrong, so the agent can fix it"
const REPLY = "Your reply"

async function openSendBack() {
  const { TodoNodeWindowContent } = await import("./TodoNodeWindowContent")
  const r = renderWithTamagui(<TodoNodeWindowContent workspaceId="ws1" appId="app1" nodeId="n1" />)
  fireEvent.click(await waitFor(() => r.getByRole("tab", { name: /Output/ })))
  fireEvent.click(await waitFor(() => r.getByText("Send back")))
  return r
}

async function openBlocked() {
  const { TodoNodeWindowContent } = await import("./TodoNodeWindowContent")
  const r = renderWithTamagui(<TodoNodeWindowContent workspaceId="ws1" appId="app1" nodeId="n2" />)
  await waitFor(() => r.getByPlaceholderText(REPLY))
  return r
}

const setStates = () => h.calls.filter((c) => c.tool === "set-state").map((c) => c.input)
const mic = (r: Awaited<ReturnType<typeof openSendBack>>) => r.getByRole("button", { name: "Record a voice note" })

beforeEach(() => {
  h.calls.length = 0
  h.tracks.length = 0
  h.recorders.length = 0
  h.transcribe.calls.length = 0
  h.state.nodes = {
    n1: node("n1", "review") as unknown as Record<string, unknown>,
    n2: node("n2", "blocked") as unknown as Record<string, unknown>,
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const track = { stopped: false, stop() { this.stopped = true } }
        h.tracks.push(track)
        return { getTracks: () => [track] }
      }),
    },
  })
})
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).mediaDevices
})

describe("voice notes in the note boxes", () => {
  it("[Pablo 2026-10-30] send-back: mic records (counter, field swapped out), stop freezes the take — the transcript only lands with the pencil, and NOTHING is sent without the primary", async () => {
    h.transcribe.impl = async () => ({ text: " The VAT line is missing " })
    const r = await openSendBack()
    fireEvent.click(mic(r))
    // Recording: the composer's row (pause + counter) takes the field's place.
    const pause = await waitFor(() => r.getByRole("button", { name: "Pause" }))
    expect(r.getByText("0:00")).toBeTruthy()
    expect(r.queryByPlaceholderText(SEND_BACK)).toBeNull()
    // The chat's engine off Safari: RecordRTC, mono, 16 kHz, WebM.
    await waitFor(() => expect(h.recorders).toHaveLength(1))
    expect(h.recorders[0].options).toMatchObject({ numberOfAudioChannels: 1, desiredSampRate: 16000, mimeType: "audio/webm" })

    // Stop → the take is held (play/discard/pencil), still nothing sent.
    fireEvent.click(pause)
    await waitFor(() => r.getByRole("button", { name: "Play" }))
    expect(setStates()).toEqual([])

    // The pencil transcribes — the text lands IN the field, never submits.
    fireEvent.click(r.getByRole("button", { name: "Transcribe to text" }))
    const field = await waitFor(() => r.getByPlaceholderText(SEND_BACK) as HTMLInputElement)
    await waitFor(() => expect(field.value).toBe("The VAT line is missing"))
    expect(field.readOnly).toBe(false)
    expect(setStates()).toEqual([])
    expect(h.transcribe.calls).toEqual([[btoa("\x01\x02\x03"), "audio/webm"]])
    expect(h.tracks[0].stopped).toBe(true)
    expect(r.getByText("Why are you sending it back?")).toBeTruthy()

    // The primary is what sends — and only that.
    fireEvent.click(r.getByText("Send back with a note").closest("[role=button]")!)
    await waitFor(() => expect(setStates()).toEqual([{ nodeId: "n1", state: "working", reply: "The VAT line is missing" }]))
  })

  it("[Pablo 2026-10-30] blocked reply: the same flow — transcript in the field, sent only by Reply and continue", async () => {
    h.transcribe.impl = async () => ({ text: "Use 21%" })
    const r = await openBlocked()
    fireEvent.click(mic(r))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Pause" })))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Transcribe to text" })))
    const field = await waitFor(() => r.getByPlaceholderText(REPLY) as HTMLInputElement)
    await waitFor(() => expect(field.value).toBe("Use 21%"))
    expect(setStates()).toEqual([])
    fireEvent.click(r.getByText("Reply and continue").closest("[role=button]")!)
    await waitFor(() => expect(setStates()).toEqual([{ nodeId: "n2", state: "working", reply: "Use 21%" }]))
  })

  it("[Pablo 2026-10-30] the transcript REPLACES the field's content — the composer's landing criteria (handleTranscribe → setText)", async () => {
    h.transcribe.impl = async () => ({ text: "mundo" })
    const r = await openSendBack()
    fireEvent.change(r.getByPlaceholderText(SEND_BACK), { target: { value: " hola " } })
    fireEvent.click(mic(r))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Pause" })))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Transcribe to text" })))
    const field = await waitFor(() => r.getByPlaceholderText(SEND_BACK) as HTMLInputElement)
    await waitFor(() => expect(field.value).toBe("mundo"))
    expect(setStates()).toEqual([])
  })

  it("[Pablo 2026-10-30] discarding the take leaves the field exactly as it was — nothing recorded, nothing sent", async () => {
    h.transcribe.impl = async () => ({ text: "nope" })
    const r = await openSendBack()
    fireEvent.change(r.getByPlaceholderText(SEND_BACK), { target: { value: "hola" } })
    fireEvent.click(mic(r))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Pause" })))
    // Discard (the X) → back to the plain field with its typed text.
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Discard" })))
    const field = await waitFor(() => r.getByPlaceholderText(SEND_BACK) as HTMLInputElement)
    await waitFor(() => expect(field.readOnly).toBe(false))
    expect(field.value).toBe("hola")
    expect(setStates()).toEqual([])
    expect(h.transcribe.calls).toEqual([])
    expect(h.tracks[0].stopped).toBe(true)
    expect(mic(r)).toBeTruthy()
  })

  it("[TODOAP-AC-37] a rejected transcription keeps the box open with the typed text, sends nothing and shows the error toast", async () => {
    h.transcribe.impl = async () => {
      throw new Error("No STT provider")
    }
    const r = await openSendBack()
    fireEvent.change(r.getByPlaceholderText(SEND_BACK), { target: { value: "hola" } })
    fireEvent.click(mic(r))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Pause" })))
    fireEvent.click(await waitFor(() => r.getByRole("button", { name: "Transcribe to text" })))
    await waitFor(() => expect(r.getByRole("alert")).toBeTruthy())
    expect(r.getByRole("alert").textContent).toContain("Couldn’t transcribe the note")
    expect(setStates()).toEqual([])
    expect(r.getByText("Why are you sending it back?")).toBeTruthy()
    const field = await waitFor(() => r.getByPlaceholderText(SEND_BACK) as HTMLInputElement)
    expect(field.value).toBe("hola")
    expect(field.readOnly).toBe(false)
    expect(mic(r)).toBeTruthy()
    expect(h.tracks[0].stopped).toBe(true)
  })

  it("[TODOAP-AC-37] a denied microphone shows the toast and leaves the box untouched", async () => {
    ;(navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("NotAllowedError"))
    const r = await openSendBack()
    fireEvent.change(r.getByPlaceholderText(SEND_BACK), { target: { value: "hola" } })
    fireEvent.click(mic(r))
    await waitFor(() => expect(r.getByRole("alert")).toBeTruthy())
    expect((r.getByPlaceholderText(SEND_BACK) as HTMLInputElement).value).toBe("hola")
    expect(h.transcribe.calls).toEqual([])
    expect(setStates()).toEqual([])
  })
})
