import { fireEvent, screen } from "@testing-library/react"
import { Linking } from "react-native"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { AuthPanel, type OAuthInfo } from "./AuthPanel"

const CONNECTED: OAuthInfo = {
  provider: "GitHub",
  status: "connected",
  authType: "github-app",
  appSlug: "teros-ai-prod",
  userLogin: "octocat",
  installationId: "77",
}

function renderPanel(oauth: OAuthInfo) {
  return renderWithTamagui(
    <AuthPanel oauth={oauth} defaultExpanded onConnect={vi.fn()} onRefresh={vi.fn()} />,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GitHub panel (010, 013, 014, 020)", () => {
  it("speaks the UI language: no Spanish in an English UI", () => {
    renderPanel(CONNECTED)
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/conectado|Desconectar|Refrescar|¿No ves|Gestionar en GitHub|Añadir cuenta/)
    expect(text).toContain("@octocat")
  })

  it("lists each installation with its own manage link (org URL for organizations)", () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true)
    renderPanel({
      ...CONNECTED,
      installed: true,
      installations: [
        {
          id: "77",
          account: "acme",
          accountType: "Organization",
          manageUrl: "https://github.com/organizations/acme/settings/installations/77",
        },
      ],
    })
    expect(screen.getByText("@acme")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Manage acme on GitHub"))
    expect(open).toHaveBeenCalledWith("https://github.com/organizations/acme/settings/installations/77")
  })

  it("an installation waiting to accept the Workflows permission says so, with the link", () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true)
    renderPanel({
      ...CONNECTED,
      installed: true,
      installations: [
        {
          id: "77",
          account: "acme",
          manageUrl: "https://github.com/organizations/acme/settings/installations/77",
          pendingPermissions: ["workflows"],
        },
      ],
    })
    expect(document.body.textContent).toMatch(/Workflows/)
    fireEvent.click(screen.getByLabelText("Review the new permissions for acme on GitHub"))
    expect(open).toHaveBeenCalledWith("https://github.com/organizations/acme/settings/installations/77")
  })

  it("connected but installed nowhere: says so and offers the install", () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true)
    renderPanel({
      ...CONNECTED,
      installed: false,
      installations: [],
      installUrl: "https://github.com/apps/teros-ai-prod/installations/select_target",
    })
    expect(document.body.textContent).toMatch(/not installed/i)
    fireEvent.click(screen.getByLabelText("Install the Teros GitHub App"))
    expect(open).toHaveBeenCalledWith("https://github.com/apps/teros-ai-prod/installations/select_target")
  })

  it("lists the branches where removed clones saved their work, with links (gh-scope-4)", () => {
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(true)
    renderPanel({
      ...CONNECTED,
      installed: true,
      installations: [],
      savedBranches: [
        {
          repo: "acme/api",
          branch: "teros/saved/agent_a/main-20261028-1015",
          savedAt: "2026-10-28T10:15:00.000Z",
          url: "https://github.com/acme/api/tree/teros/saved/agent_a/main-20261028-1015",
        },
      ],
    })
    expect(document.body.textContent).toContain("teros/saved/agent_a/main-20261028-1015")
    fireEvent.click(screen.getByLabelText("Open teros/saved/agent_a/main-20261028-1015 on GitHub"))
    expect(open).toHaveBeenCalledWith("https://github.com/acme/api/tree/teros/saved/agent_a/main-20261028-1015")
  })

  it("says clones are removed when done and unsaved work goes to a branch (gh-scope-4)", () => {
    renderPanel({ ...CONNECTED, installed: true, installations: [] })
    expect(document.body.textContent).toMatch(/removed when they are no longer used/i)
    expect(document.body.textContent).toMatch(/teros\/saved/)
  })

  it("tells who can see cloned code", () => {
    renderPanel({ ...CONNECTED, installed: true, installations: [] })
    expect(document.body.textContent).toMatch(/other agents in this workspace/i)
  })

  it("has no Disconnect of its own (the window header has the one, with a confirmation)", () => {
    renderWithTamagui(<AuthPanel oauth={CONNECTED} defaultExpanded onDisconnect={vi.fn()} />)
    expect(screen.queryByText(/^Disconnect$/)).toBeNull()
  })
})

describe("Disconnect asks first (010)", () => {
  it("one tap does not disconnect; confirming does", async () => {
    const { DisconnectButton } = await import("./AuthPanel")
    const onConfirm = vi.fn()
    renderWithTamagui(<DisconnectButton provider="GitHub" label="Disconnect" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText("Disconnect"))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/every agent/i)
    fireEvent.click(screen.getByText("Confirm"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
