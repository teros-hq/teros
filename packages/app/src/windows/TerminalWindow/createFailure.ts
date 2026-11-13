import type { TFunction } from "i18next"

export interface CreateFailure {
  terminalId: string
  code: string
}

export type EmptyView = "opening" | "create-failed" | "gone"

export function createFailureOf(terminalId: string, err: unknown): CreateFailure {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === "string" && code) return { terminalId, code }
  const timedOut = err instanceof Error && /timeout/i.test(err.message)
  return { terminalId, code: timedOut ? "TIMEOUT" : "UNKNOWN" }
}

export function emptyViewOf(view: {
  terminalId?: string
  opening: boolean
  failure: CreateFailure | null
}): EmptyView {
  if (view.failure && view.failure.terminalId === view.terminalId) return "create-failed"
  return view.opening ? "opening" : "gone"
}

export function createFailureReason(failure: Pick<CreateFailure, "code">, t: TFunction): string {
  if (failure.code === "TIMEOUT")
    return t("terminal.window.failedTimeout", {
      defaultValue: "It took too long to start. Try again.",
    })
  if (failure.code === "FORBIDDEN_WORKSPACE_ROLE" || failure.code === "FORBIDDEN_WORKSPACE")
    return t("terminal.window.failedRole", {
      defaultValue: "You need write access to this workspace to open a terminal.",
    })
  if (failure.code === "PERSONAL_APP")
    return t("terminal.window.failedPersonalBash", {
      defaultValue: "Bash is personal here, so it cannot run a shared terminal.",
    })
  if (failure.code === "FORBIDDEN_APP")
    return t("terminal.window.failedOthersBash", {
      defaultValue:
        "Bash here is another member's personal app. Ask them to share it with the workspace.",
    })
  return t("terminal.window.failedUnknown", {
    defaultValue: "Something went wrong while starting it. Try again.",
  })
}
