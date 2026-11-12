/**
 * The task's runner terminal (CCR-REQ-8): the 13 px terminal icon that sits
 * right of the assignee avatar in tree and day rows — the "jump to the work
 * context" bubble for tasks worked by a Claude Code runner (no conversation).
 *
 * Click: the terminal alive → the backend reveals it in the person's Terminal
 * window; gone → the backend recreates it with `claude --resume <sessionId>`
 * (context intact) and reveals that. The icon dims while the session sleeps
 * (one click wakes it) and shows a "recreate" hint when it is gone.
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { ActivityIndicator, Pressable, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { showTerminalSession } from "../../TerminalWindow/terminalSessions"
import type { RunnerFields } from "../model/types"
import { callTodo } from "../data/todoApi"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

/**
 * @spec CCR-REQ-8 Open the task's work context: the backend reveals the
 * runner's terminal (recreating it with `--resume` when it is gone) and the
 * Terminal window shows that session. Failures surface through `onFail` —
 * the caller routes them to the window's error toast — instead of being
 * swallowed into a console warning (2026-10-31: the day-view terminal icon
 * looked dead because the swallowed error hid "Tool mapping not found").
 */
export async function openRunnerTerminal(
  appId: string,
  workspaceId: string | null | undefined,
  nodeId: string,
  onFail?: (message: string) => void,
): Promise<void> {
  try {
    const res = await callTodo<{ terminalId: string; resumed: boolean }>(
      appId,
      "open-runner-terminal",
      { nodeId },
    )
    if (res.terminalId) showTerminalSession(workspaceId, res.terminalId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[todo] open-runner-terminal failed:", message)
    onFail?.(message)
  }
}

/** Effective status: an absent/legacy status reads as live (the session was just opened). */
export function runnerStatusOf(r: RunnerFields | null | undefined): "live" | "sleeping" | "gone" {
  return r?.status ?? "live"
}

/** One row's runner bubble: `runner` (a terminal to jump to) or null. */
export function TerminalIcon({
  runner,
  onOpen,
}: {
  runner: RunnerFields
  onOpen: (runner: RunnerFields) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const status = runnerStatusOf(runner)
  const label =
    status === "gone"
      ? t("todo.runner.recreate")
      : status === "sleeping"
        ? t("todo.runner.wake")
        : t("todo.runner.open")
  return (
    <Pressable
      testID="todo-row-terminal"
      accessibilityRole="button"
      accessibilityLabel={label}
      {...({ title: label, tabIndex: -1 } as Record<string, unknown>)}
      onPress={(e: any) => {
        e?.stopPropagation?.()
        onOpen(runner)
      }}
      hitSlop={6}
      style={({ hovered }: any) => [
        {
          width: 18,
          height: 18,
          marginLeft: -4,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? td.controlBg : "transparent",
          opacity: status === "live" ? 1 : 0.55,
        },
        web({ cursor: "pointer", transition: "background .2s, opacity .2s" }) as ViewStyle,
      ]}
    >
      {({ hovered }: any) => (
        <Ph
          name={status === "gone" ? "arrow-counter-clockwise" : "terminal-window"}
          size={13}
          color={hovered ? td.text : td.text3}
        />
      )}
    </Pressable>
  )
}

/** The working indicator while the runner session is live (kept for parity with Dot's running). */
export function RunnerLiveDot({ runner }: { runner: RunnerFields }) {
  const td = useTd()
  if (runnerStatusOf(runner) !== "live") return null
  return <ActivityIndicator size="small" color={td.accent} style={{ width: 12, height: 12 }} />
}
