/**
 * The driver line ("Atlas conduce", "Tú conduces", "Te toca · Atlas espera",
 * "Nadie al volante", "Lucía y tú a la vez"): the same words in the rail's
 * hover card, the header, a floating window and the chat card.
 */

import i18n from "../../../i18n"
import { useAuthStore } from "../../../store/authStore"
import type { TerminalSession } from "../terminalSessions"
import { describeSeat, firstName, isUnnamedAgent, type SeatView, seatColor } from "./crewModel"

export interface DriverLine {
  /** The bold, coloured part (a name, "Tú", "Te toca"), or null. */
  who: string | null
  /** The rest of the line, after a space. */
  rest: string
  /** Text colour of `who` on the dark terminal chrome. */
  color: string
}

function agentName(view: SeatView): string {
  if (isUnnamedAgent(view.driver))
    return i18n.t("terminal.crew.theAgent", { defaultValue: "The agent" })
  return (
    firstName(view.driver.name) || i18n.t("terminal.crew.theAgent", { defaultValue: "The agent" })
  )
}

/** The driver line of a seat. `me` names "you" in a conflict. */
export function driverLine(view: SeatView, me?: string): DriverLine {
  const color = seatColor(view).text
  switch (view.seat) {
    case "agent":
      return {
        who: agentName(view),
        rest: i18n.t("terminal.crew.drives", { defaultValue: "drives" }),
        color,
      }
    case "human":
      return view.mine
        ? {
            who: i18n.t("terminal.crew.you", { defaultValue: "You" }),
            rest: i18n.t("terminal.crew.youDrive", { defaultValue: "drive" }),
            color,
          }
        : {
            who: firstName(view.driver.name) || "?",
            rest: i18n.t("terminal.crew.drives", { defaultValue: "drives" }),
            color,
          }
    case "need":
      return {
        who: i18n.t("terminal.crew.yourTurn", { defaultValue: "Your turn" }),
        rest: `· ${i18n.t("terminal.crew.agentWaits", {
          defaultValue: "{{name}} is waiting",
          name: agentName(view),
        })}`,
        color,
      }
    case "clash": {
      const names = view.clash.map((p) =>
        me && p.id === me
          ? i18n.t("terminal.crew.youLower", { defaultValue: "you" })
          : firstName(p.name) || "?",
      )
      // "Lucía y tú": the other person first, you last.
      names.sort((a, b) =>
        a === i18n.t("terminal.crew.youLower", { defaultValue: "you" })
          ? 1
          : b === i18n.t("terminal.crew.youLower", { defaultValue: "you" })
            ? -1
            : 0,
      )
      return {
        who: i18n.t("terminal.crew.pair", {
          defaultValue: "{{a}} and {{b}}",
          a: names[0] ?? "?",
          b: names[1] ?? "?",
        }),
        rest: i18n.t("terminal.crew.atOnce", { defaultValue: "at once" }),
        color,
      }
    }
    default:
      return {
        who: null,
        rest: i18n.t("terminal.crew.nobody", { defaultValue: "Nobody at the wheel" }),
        color: seatColor(view).text,
      }
  }
}

/** Plain driver line of a session ("Atlas conduce"), for titles and labels. */
export function driverLabel(
  session: TerminalSession,
  me: string | undefined = useAuthStore.getState().user?.userId,
  now: number = Date.now(),
): string {
  const line = driverLine(describeSeat(session, me, now), me)
  return line.who ? `${line.who} ${line.rest}` : line.rest
}
