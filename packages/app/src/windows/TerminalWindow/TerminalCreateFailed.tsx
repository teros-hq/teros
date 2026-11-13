import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Btn, EmptyState, T } from "../../components/ui/ds"
import { type CreateFailure, createFailureReason } from "./createFailure"
import { sharedOfferNote } from "./terminalChrome"
import type { SharedOffer } from "./terminalWindowModel"

interface Props {
  failure: CreateFailure
  onRetry: () => void
  onSessions: () => void
  onPersonal?: () => void
  offer?: SharedOffer
}

export function TerminalCreateFailed({ failure, onRetry, onSessions, onPersonal, offer }: Props) {
  const { t } = useTranslation()
  const personalPrimary = failure.code === "PERSONAL_APP" && !!onPersonal
  const fix = failure.code === "PERSONAL_APP" ? sharedOfferNote(offer, t) : undefined
  return (
    <View testID="terminal-create-failed">
      <EmptyState
        icon="warning"
        title={t("terminal.window.failedTitle", { defaultValue: "This terminal did not open" })}
        text={createFailureReason(failure, t)}
        action={
          <View style={{ alignItems: "center", gap: 10 }}>
            {fix ? (
              <T step="sm" tone="text3" center testID="terminal-failed-fix">
                {fix}
              </T>
            ) : null}
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 }}
            >
              <Btn
                variant={personalPrimary ? "sec" : "primary"}
                icon="arrow-clockwise"
                onPress={onRetry}
                testID="terminal-failed-retry"
              >
                {t("terminal.window.failedRetry", { defaultValue: "Try again" })}
              </Btn>
              {onPersonal ? (
                <Btn
                  variant={personalPrimary ? "primary" : "sec"}
                  icon="lock-simple"
                  onPress={onPersonal}
                  testID="terminal-failed-personal"
                >
                  {t("terminal.window.openPersonal", {
                    defaultValue: "Open a personal terminal",
                  })}
                </Btn>
              ) : null}
              <Btn icon="list" onPress={onSessions} testID="terminal-failed-sessions">
                {t("terminal.window.sessions", { defaultValue: "Sessions" })}
              </Btn>
            </View>
          </View>
        }
      />
    </View>
  )
}
