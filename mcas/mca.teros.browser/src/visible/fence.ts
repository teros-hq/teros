/**
 * Consent + take-over fence of a visible tab (spec BRW-REQ-5; semantics from
 * the desktop browser, DBAC-REQ-2/3). Pure, clock-injectable.
 *
 *   consent  the person's toggle in the Browser window, OFF by default —
 *            without it every input tool on the tab is refused.
 *   fence    the person holds the tab while it has their focus and they
 *            touched it in the last 2.5 s, and for 1.5 s after it lost focus.
 */

export const FENCE_INPUT_GRACE_MS = 2_500
export const FENCE_BLUR_GRACE_MS = 1_500

export type ControlHolder = "human" | "agent" | "none"

export interface FenceStatus {
  control: ControlHolder
  fence: { consent: boolean; humanActive: boolean; agentPriority: boolean }
}

export class Fence {
  consent = false
  humanActiveUntil = 0
  focused = false
  agentPriority = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  onHumanInput(): void {
    if (!this.focused) return
    this.humanActiveUntil = this.now() + FENCE_INPUT_GRACE_MS
  }

  onFocus(): void {
    this.focused = true
  }

  onBlur(): void {
    this.focused = false
    const blurUntil = this.now() + FENCE_BLUR_GRACE_MS
    if (this.humanActiveUntil > blurUntil) this.humanActiveUntil = blurUntil
  }

  humanActive(): boolean {
    return this.now() < this.humanActiveUntil
  }

  holder(): ControlHolder {
    if (this.humanActive()) return "human"
    return this.agentPriority ? "agent" : "none"
  }

  status(): FenceStatus {
    return {
      control: this.holder(),
      fence: {
        consent: this.consent,
        humanActive: this.humanActive(),
        agentPriority: this.agentPriority,
      },
    }
  }
}

export interface GateRefusal {
  code: "agent_control_disabled" | "human_has_control"
  message: string
}

/** @spec BRW-REQ-5 — why an agent input must not run on this tab right now, or null. */
export function gate(fence: Fence): GateRefusal | null {
  if (!fence.consent) {
    return {
      code: "agent_control_disabled",
      message:
        "The user has not enabled agent control for this tab (the toggle in the Browser window is off).",
    }
  }
  if (fence.humanActive()) {
    return {
      code: "human_has_control",
      message: "A person is using this tab right now — wait a few seconds and retry.",
    }
  }
  return null
}
