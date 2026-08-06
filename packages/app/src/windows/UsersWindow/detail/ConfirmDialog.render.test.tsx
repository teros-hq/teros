/**
 * ConfirmDialog — accessible confirmation modal. Assertions that BITE:
 *   - renders as role="dialog" and moves focus to it on open,
 *   - renders nothing while closed,
 *   - Esc and the Cancel button call onCancel,
 *   - the Confirm button calls onConfirm,
 *   - while `busy` the Confirm button is disabled and never fires onConfirm.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/detail/ConfirmDialog.render.test.tsx
 */
import { fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog"

function setup(over: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const utils = renderWithTamagui(
    <ConfirmDialog
      open
      title="Suspend Ana?"
      body="Ana loses access immediately."
      confirmLabel="Suspend"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  )
  return { ...utils, onConfirm, onCancel }
}

describe("ConfirmDialog", () => {
  it("renders as role=dialog and moves focus to it on open", () => {
    const { getByRole } = setup()
    const dialog = getByRole("dialog")
    expect(dialog).toBeTruthy()
    expect(document.activeElement).toBe(dialog)
  })

  it("renders nothing when closed", () => {
    const { queryByRole } = setup({ open: false })
    expect(queryByRole("dialog")).toBeNull()
  })

  it("Escape calls onCancel", () => {
    const { getByRole, onCancel } = setup()
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("the Cancel button calls onCancel", () => {
    const { getByTestId, onCancel } = setup()
    fireEvent.click(getByTestId("confirm-dialog-cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("the Confirm button calls onConfirm", () => {
    const { getByTestId, onConfirm } = setup()
    fireEvent.click(getByTestId("confirm-dialog-confirm"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("disables Confirm while busy (never fires onConfirm)", () => {
    const { getByTestId, onConfirm } = setup({ busy: true })
    const confirmBtn = getByTestId("confirm-dialog-confirm")
    expect(confirmBtn.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(confirmBtn)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
