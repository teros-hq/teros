/**
 * DeleteAccountDialog — the assertions that bite:
 *   - the confirm button stays disabled until the typed email matches
 *     (case-insensitive, trimmed), and never calls the API while disabled;
 *   - mfaEnabled shows the MFA field (no password); otherwise the password field;
 *     hasPassword=false shows neither (OAuth-only accounts confirm with the email);
 *   - the API receives the EXACT payload (confirmEmail + password | mfaCode);
 *   - MFA_REQUIRED swaps the password field for the MFA field;
 *   - MISSING_FIELDS makes the password required (confirm disabled until typed);
 *   - ACCOUNT_DELETION_BLOCKED lists the blocking workspaces by name (id fallback);
 *   - success calls onDeleted (the caller's logout path).
 *
 *   cd packages/app && npx vitest run src/windows/ProfileWindow/DeleteAccountDialog.render.test.tsx
 */
import { fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"

const h = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  listWorkspaces: vi.fn(),
}))

vi.mock("../../services/terosClientSingleton", () => {
  const client = {
    profile: { deleteAccount: h.deleteAccount },
    workspace: { listWorkspaces: h.listWorkspaces },
  }
  return { getTerosClient: () => client }
})

import {
  DeleteAccountDialog,
  type DeleteAccountDialogProps,
  parseBlockedWorkspaceIds,
} from "./DeleteAccountDialog"

function setup(over: Partial<DeleteAccountDialogProps> = {}) {
  const onDeleted = vi.fn()
  const onCancel = vi.fn()
  const utils = renderWithTamagui(
    <DeleteAccountDialog
      open
      email="Dana@Example.com"
      onDeleted={onDeleted}
      onCancel={onCancel}
      {...over}
    />,
  )
  const type = (testId: string, value: string) =>
    fireEvent.change(utils.getByTestId(testId), { target: { value } })
  const confirm = () => utils.getByTestId("delete-account-confirm")
  return { ...utils, onDeleted, onCancel, type, confirm }
}

function codedError(code: string, message = code) {
  return Object.assign(new Error(message), { code })
}

beforeEach(() => {
  h.deleteAccount.mockReset()
  h.listWorkspaces.mockReset()
})

describe("DeleteAccountDialog", () => {
  it("keeps confirm disabled until the typed email matches (case-insensitive)", () => {
    const { type, confirm } = setup()
    expect(confirm().getAttribute("aria-disabled")).toBe("true")

    type("delete-account-email", "dana@example.co")
    expect(confirm().getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(confirm())
    expect(h.deleteAccount).not.toHaveBeenCalled()

    type("delete-account-email", "  DANA@example.com ")
    expect(confirm().getAttribute("aria-disabled")).not.toBe("true")
  })

  it("shows the password field (and no MFA field) by default", () => {
    const { queryByTestId } = setup()
    expect(queryByTestId("delete-account-password")).toBeTruthy()
    expect(queryByTestId("delete-account-mfa")).toBeNull()
  })

  it("shows the MFA field (and no password field) when MFA is enabled", () => {
    const { queryByTestId, type, confirm } = setup({ mfaEnabled: true })
    expect(queryByTestId("delete-account-mfa")).toBeTruthy()
    expect(queryByTestId("delete-account-password")).toBeNull()
    // The MFA code is required on top of the email
    type("delete-account-email", "dana@example.com")
    expect(confirm().getAttribute("aria-disabled")).toBe("true")
    type("delete-account-mfa", "123456")
    expect(confirm().getAttribute("aria-disabled")).not.toBe("true")
  })

  it("shows no secret field for an OAuth-only account without MFA", () => {
    const { queryByTestId } = setup({ hasPassword: false })
    expect(queryByTestId("delete-account-password")).toBeNull()
    expect(queryByTestId("delete-account-mfa")).toBeNull()
  })

  it("calls the API with confirmEmail + password, then onDeleted", async () => {
    h.deleteAccount.mockResolvedValue({ ok: true })
    const { type, confirm, onDeleted } = setup()
    type("delete-account-email", "dana@example.com")
    type("delete-account-password", "right-pass")
    fireEvent.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(h.deleteAccount).toHaveBeenCalledWith({
      confirmEmail: "dana@example.com",
      password: "right-pass",
    })
  })

  it("calls the API with confirmEmail + mfaCode when MFA is enabled", async () => {
    h.deleteAccount.mockResolvedValue({ ok: true })
    const { type, confirm, onDeleted } = setup({ mfaEnabled: true })
    type("delete-account-email", "dana@example.com")
    type("delete-account-mfa", " 123456 ")
    fireEvent.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(h.deleteAccount).toHaveBeenCalledWith({
      confirmEmail: "dana@example.com",
      mfaCode: "123456",
    })
  })

  it("omits an empty optional password", async () => {
    h.deleteAccount.mockResolvedValue({ ok: true })
    const { type, confirm, onDeleted } = setup()
    type("delete-account-email", "dana@example.com")
    fireEvent.click(confirm())
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(h.deleteAccount).toHaveBeenCalledWith({ confirmEmail: "dana@example.com" })
  })

  it("MFA_REQUIRED swaps the password field for the MFA field", async () => {
    h.deleteAccount.mockRejectedValueOnce(codedError("MFA_REQUIRED"))
    const { type, confirm, findByTestId, queryByTestId, getByTestId, onDeleted } = setup()
    type("delete-account-email", "dana@example.com")
    fireEvent.click(confirm())
    expect(await findByTestId("delete-account-mfa")).toBeTruthy()
    expect(queryByTestId("delete-account-password")).toBeNull()
    expect(getByTestId("delete-account-error").textContent).toContain("mfaRequired")
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it("MISSING_FIELDS makes the password required", async () => {
    h.deleteAccount.mockRejectedValueOnce(codedError("MISSING_FIELDS"))
    const { type, confirm, findByTestId } = setup()
    type("delete-account-email", "dana@example.com")
    fireEvent.click(confirm())
    expect((await findByTestId("delete-account-error")).textContent).toContain("passwordRequired")
    await waitFor(() => expect(confirm().getAttribute("aria-disabled")).toBe("true"))
    type("delete-account-password", "pw")
    expect(confirm().getAttribute("aria-disabled")).not.toBe("true")
  })

  it("maps INVALID_CREDENTIALS to its message", async () => {
    h.deleteAccount.mockRejectedValueOnce(codedError("INVALID_CREDENTIALS"))
    const { type, confirm, findByTestId } = setup()
    type("delete-account-email", "dana@example.com")
    type("delete-account-password", "wrong")
    fireEvent.click(confirm())
    expect((await findByTestId("delete-account-error")).textContent).toContain("invalidCredentials")
  })

  it("ACCOUNT_DELETION_BLOCKED lists the blocking workspaces by name, id as fallback", async () => {
    h.deleteAccount.mockRejectedValueOnce(
      codedError(
        "ACCOUNT_DELETION_BLOCKED",
        "Transfer or delete these shared workspaces first (they have other members): w_team, w_gone",
      ),
    )
    h.listWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: "w_team", name: "Team Rocket", status: "active", createdAt: "" }],
    })
    const { type, confirm, findByTestId, getByTestId, onDeleted } = setup()
    type("delete-account-email", "dana@example.com")
    type("delete-account-password", "right-pass")
    fireEvent.click(confirm())
    expect(await findByTestId("delete-account-blocked")).toBeTruthy()
    expect(getByTestId("delete-account-blocked-w_team").textContent).toContain("Team Rocket")
    expect(getByTestId("delete-account-blocked-w_gone").textContent).toContain("w_gone")
    expect(getByTestId("delete-account-error").textContent).toContain("blocked")
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it("parses the blocking workspace ids out of the backend message", () => {
    expect(
      parseBlockedWorkspaceIds(
        "Transfer or delete these shared workspaces first (they have other members): w_a, w_b",
      ),
    ).toEqual(["w_a", "w_b"])
    expect(parseBlockedWorkspaceIds(undefined)).toEqual([])
  })

  it("Cancel calls onCancel", () => {
    const { getByTestId, onCancel } = setup()
    fireEvent.click(getByTestId("delete-account-cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
