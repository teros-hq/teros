/**
 * The two bottom Sheets the dashboard drives: the awaitable tool input form (Task 2 / D-01/D-02/D-03)
 * and the content-aware destructive-confirm (plan 03 Task 2 / D-09/D-10). Both reuse the tamagui
 * `Sheet` primitive (no alert-dialog dep — D-10); their content is built from the `ui/ds`
 * primitives. Extracted so the dashboard render stays lean.
 */
import type React from "react"
import { View } from "react-native"
import { Sheet } from "tamagui"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { McaInputForm } from "./McaInputForm"
import type { ActiveForm } from "./mcaHealth.utils"
import { useColors } from "../../components/mca/primitives/useColors"
import { Btn, T } from "../../components/ui/ds"

type Translate = (key: string, opts?: Record<string, unknown>) => string

function sheetPaddingBottom(insetBottom: number): number {
  return Math.max(insetBottom, 40)
}

const SheetOverlay = () => (
  <Sheet.Overlay
    animation={"lazy" as never}
    enterStyle={{ opacity: 0 }}
    exitStyle={{ opacity: 0 }}
    backgroundColor="rgba(23, 20, 31, 0.55)"
  />
)

/** Input-form bottom Sheet — flat schemas render generated fields; nested/array fall back to raw JSON. */
export function InputFormSheet({
  activeForm,
  formValues,
  setFormValues,
  rawJson,
  setRawJson,
  onClose,
  onSubmit,
  t,
}: {
  activeForm: ActiveForm | null
  formValues: Record<string, unknown>
  setFormValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
  rawJson: string
  setRawJson: (v: string) => void
  onClose: () => void
  onSubmit: () => void
  t: Translate
}) {
  const insets = useSafeAreaInsets()
  const c = useColors()
  return (
    <Sheet
      modal
      open={!!activeForm}
      onOpenChange={(open: boolean) => !open && onClose()}
      snapPoints={[70]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <SheetOverlay />
      <Sheet.Frame
        backgroundColor={c.bgStep}
        borderTopLeftRadius={24}
        borderTopRightRadius={24}
        padding={24}
        paddingBottom={sheetPaddingBottom(insets.bottom)}
        gap={16}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />
        {activeForm && (
          <McaInputForm
            activeForm={activeForm}
            formValues={formValues}
            setFormValues={setFormValues}
            rawJson={rawJson}
            setRawJson={setRawJson}
            onCancel={onClose}
            onSubmit={onSubmit}
            t={t}
          />
        )}
      </Sheet.Frame>
    </Sheet>
  )
}

/** Destructive-confirm Sheet — NAMES each destructive tool; Run executes, Cancel keeps read-only. */
export function DestructiveConfirmSheet({
  pending,
  onConfirm,
  onCancel,
  t,
}: {
  pending: { mcaId: string; tools: string[] } | null
  onConfirm: () => void
  onCancel: () => void
  t: Translate
}) {
  const insets = useSafeAreaInsets()
  const c = useColors()
  return (
    <Sheet
      modal
      open={!!pending}
      onOpenChange={(open: boolean) => !open && onCancel()}
      snapPoints={[40]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <SheetOverlay />
      <Sheet.Frame
        backgroundColor={c.bgStep}
        borderTopLeftRadius={24}
        borderTopRightRadius={24}
        padding={24}
        paddingBottom={sheetPaddingBottom(insets.bottom)}
        gap={16}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />
        {pending && (
          <View style={{ gap: 14 }}>
            <T step="xl">{t("mca.status.confirm.title")}</T>
            <T step="sm" tone="text2">
              {t("mca.status.confirm.body", { tools: pending.tools.join(", ") })}
            </T>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              <Btn variant="sec" full style={{ flex: 1 }} onPress={onCancel}>
                {t("mca.status.confirm.cancel")}
              </Btn>
              <Btn variant="danger" icon="warning" full style={{ flex: 1 }} onPress={onConfirm}>
                {t("mca.status.confirm.run")}
              </Btn>
            </View>
          </View>
        )}
      </Sheet.Frame>
    </Sheet>
  )
}
