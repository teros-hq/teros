/**
 * The two bottom Sheets the dashboard drives: the awaitable tool input form (Task 2 / D-01/D-02/D-03)
 * and the content-aware destructive-confirm (plan 03 Task 2 / D-09/D-10). Both reuse the tamagui
 * `Sheet` primitive (no alert-dialog dep — D-10). Extracted so the dashboard render stays lean.
 */
import type React from "react"
import { Button, Sheet, Text, XStack, YStack } from "tamagui"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { McaInputForm } from "./McaInputForm"
import type { ActiveForm } from "./mcaHealth.utils"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, controlsBar } from "../../components/mca/primitives/colors"

type Translate = (key: string, opts?: Record<string, unknown>) => string

function sheetPaddingBottom(insetBottom: number): number {
  return Math.max(insetBottom, 40)
}

const SheetOverlay = () => (
  <Sheet.Overlay
    animation={"lazy" as never}
    enterStyle={{ opacity: 0 }}
    exitStyle={{ opacity: 0 }}
    backgroundColor="rgba(0, 0, 0, 0.5)"
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
        backgroundColor={c.bgCard}
        borderTopLeftRadius="$5"
        borderTopRightRadius="$5"
        padding="$4"
        paddingBottom={sheetPaddingBottom(insets.bottom)}
        gap="$4"
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
        backgroundColor={c.bgCard}
        borderTopLeftRadius="$5"
        borderTopRightRadius="$5"
        padding="$4"
        paddingBottom={sheetPaddingBottom(insets.bottom)}
        gap="$4"
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />
        {pending && (
          <YStack gap="$4">
            <Text fontSize="$5" fontWeight="600" color="$color">
              {t("mca.status.confirm.title")}
            </Text>
            <Text fontSize="$3" color="$gray11">
              {t("mca.status.confirm.body", { tools: pending.tools.join(", ") })}
            </Text>
            <XStack gap="$3" marginTop="$2">
              <Button
                flex={1}
                size="$4"
                onPress={onCancel}
                backgroundColor={c.bgCardHover}
                borderWidth={1}
                borderColor={c.borderStrong}
              >
                <Text color="$gray11">{t("mca.status.confirm.cancel")}</Text>
              </Button>
              <Button
                flex={1}
                size="$4"
                onPress={onConfirm}
                backgroundColor={controlsBar.deny.bg}
                borderWidth={1}
                borderColor={controlsBar.deny.border}
              >
                <Text color={semanticColors.red}>{t("mca.status.confirm.run")}</Text>
              </Button>
            </XStack>
          </YStack>
        )}
      </Sheet.Frame>
    </Sheet>
  )
}
