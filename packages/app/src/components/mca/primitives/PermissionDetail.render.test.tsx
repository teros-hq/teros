/**
 * Render tests — PermissionDetail.
 *
 * The card must be useful in every metadata state, because the Allow/Deny
 * controls are never gated on the fetch (spec success criterion 5).
 */

import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

import { PermissionDetail } from "./PermissionDetail"

const DETAIL = {
  requestedName: "mydrive_share-file",
  name: "share-file",
  description: "Grant another account access to a Drive file.",
  parameters: {
    type: "object" as const,
    properties: { fileId: { type: "string", description: "Target file." } },
    required: ["fileId"],
  },
  annotations: { destructiveHint: true, openWorldHint: true },
}

describe("PermissionDetail", () => {
  it("(1) renders the tool description as the intent line", () => {
    useToolDetails.mockReturnValue({
      details: { "mydrive_share-file": DETAIL },
      loading: false,
      failed: false,
    })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_share-file"
        appId="a1"
        mcaId="mca.google.drive"
        input={{ fileId: "f1" }}
        fallbackText="Wants to share file"
      />,
    )

    expect(screen.getByText("Grant another account access to a Drive file.")).toBeTruthy()
  })

  it("(2) prefers annotations.summary over the description", () => {
    useToolDetails.mockReturnValue({
      details: {
        "mydrive_share-file": {
          ...DETAIL,
          annotations: { ...DETAIL.annotations, summary: "Shares a file with someone." },
        },
      },
      loading: false,
      failed: false,
    })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_share-file"
        appId="a1"
        input={{ fileId: "f1" }}
        fallbackText="Wants to share file"
      />,
    )

    expect(screen.getByText("Shares a file with someone.")).toBeTruthy()
  })

  it("(3) renders capability badges from annotations", () => {
    useToolDetails.mockReturnValue({
      details: { "mydrive_share-file": DETAIL },
      loading: false,
      failed: false,
    })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_share-file"
        appId="a1"
        input={{ fileId: "f1" }}
        fallbackText="Wants to share file"
      />,
    )

    expect(screen.getByText("Irreversible")).toBeTruthy()
    expect(screen.getByText("Network")).toBeTruthy()
  })

  it("(4) renders the read-only badge for a read-only tool", () => {
    useToolDetails.mockReturnValue({
      details: {
        "mydrive_list-files": {
          ...DETAIL,
          requestedName: "mydrive_list-files",
          annotations: { readOnlyHint: true },
        },
      },
      loading: false,
      failed: false,
    })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_list-files"
        appId="a1"
        fallbackText="Wants to list files"
      />,
    )

    expect(screen.getByText("Reads only")).toBeTruthy()
  })

  it("(5) falls back to the tense text while metadata is loading", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: true, failed: false })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_share-file"
        appId="a1"
        input={{ fileId: "f1" }}
        fallbackText="Wants to share file"
      />,
    )

    expect(screen.getByText("Wants to share file")).toBeTruthy()
    // No schema has reached the card yet — every param must render clean,
    // never flagged "not in schema" (that tag means "checked and absent").
    expect(screen.queryByText("not in schema")).toBeNull()
    // Still loading is not the same as failed: don't tell the user we gave up
    // while a fetch is in flight.
    expect(screen.queryByTestId("permission-detail-unavailable")).toBeNull()
  })

  it("(6) still renders params after a failed metadata fetch, and SAYS it failed", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: true })

    renderWithTamagui(
      <PermissionDetail
        toolName="mydrive_share-file"
        appId="a1"
        input={{ fileId: "f1" }}
        fallbackText="Wants to share file"
      />,
    )

    expect(screen.getByText("Wants to share file")).toBeTruthy()
    expect(screen.getByText("fileId")).toBeTruthy()
    expect(screen.getByText("f1")).toBeTruthy()
    // No schema reached the card because the fetch failed — same guarantee
    // as the loading state above.
    expect(screen.queryByText("not in schema")).toBeNull()
    // This is what makes (5) and (6) different tests rather than the same test
    // twice: a card whose metadata failed must not be indistinguishable from a
    // tool that genuinely declares no description, no schema and no annotations.
    // The missing "Irreversible" badge would otherwise read as reassurance.
    expect(screen.getByTestId("permission-detail-unavailable")).toBeTruthy()
  })

  it("(7) shows the irreversible badge from the prop even without annotations", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: true })

    renderWithTamagui(
      <PermissionDetail
        toolName="fs_delete"
        appId="a1"
        fallbackText="Wants to delete"
        irreversible
      />,
    )

    expect(screen.getByText("Irreversible")).toBeTruthy()
  })

  it("(8) showBadges=false suppresses the badge strip for a caller that already shows it", () => {
    // The grouped panel renders the badges on the collapsed row; repeating them
    // in the expansion would say the same thing twice for one tool.
    useToolDetails.mockReturnValue({ details: { fs_delete: DETAIL }, loading: false, failed: false })

    renderWithTamagui(
      <PermissionDetail
        toolName="fs_delete"
        appId="a1"
        fallbackText="Wants to delete"
        irreversible
        showBadges={false}
      />,
    )

    expect(screen.queryByText("Irreversible")).toBeNull()
    expect(screen.queryByText("Network")).toBeNull()
    // The intent line and params still render — only the badges are suppressed.
    expect(screen.getByTestId("permission-detail-intent")).toBeTruthy()
  })

  it("(9) a wrong-typed override argument still renders a card instead of throwing", () => {
    // Raw LLM arguments reach layer 1 unvalidated (the MCA validates AFTER
    // approval). A throw here has no error boundary between it and the chat root.
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })

    expect(() =>
      renderWithTamagui(
        <PermissionDetail
          toolName="bash_run"
          appId="a1"
          mcaId="mca.teros.bash"
          input={{ command: 123 }}
          fallbackText="Wants to run command"
        />,
      ),
    ).not.toThrow()

    expect(screen.getByText("Wants to run command")).toBeTruthy()
  })
})
