/**
 * UsersHeader — the admin Users panel header, in the OS prototype vocabulary:
 * a `PageHead` (uppercase accent eyebrow · serif title · sans lead · actions).
 *
 * Takes a generic `crumbs` breadcrumb (list → detail drill-in): the last crumb
 * is the title, an earlier pressable crumb becomes the ghost "← back" action.
 * `statusText` is the lead (falls back to the window subtitle) and `controls`
 * land in the actions slot.
 */

import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Btn, PageHead } from "../../components/ui/ds"

export interface Crumb {
  label: string
  /** When set, the crumb is a pressable navigation target (e.g. back to the list). */
  onPress?: () => void
}

export function UsersHeader({
  crumbs,
  statusText,
  controls,
}: {
  crumbs: Crumb[]
  statusText?: string
  controls?: ReactNode
}) {
  const { t } = useTranslation()
  const last = crumbs[crumbs.length - 1]
  const back = crumbs.find((crumb, i) => i < crumbs.length - 1 && crumb.onPress)
  const actions =
    back || controls ? (
      <>
        {back ? (
          <Btn
            variant="ghost"
            size="sm"
            icon="arrow-left"
            onPress={back.onPress}
            aria-label={`Back to ${back.label}`}
          >
            {back.label}
          </Btn>
        ) : null}
        {controls}
      </>
    ) : undefined

  return (
    <PageHead
      eyebrow={t("users.eyebrow", { defaultValue: "ADMINISTRACIÓN DE LA PLATAFORMA" })}
      title={last?.label ?? ""}
      lead={statusText ?? t("windows.usersSub")}
      actions={actions}
    />
  )
}
