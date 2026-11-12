import { fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../../i18n"
import { renderWithTamagui } from "../../../../test/renderWithTamagui"
import { PermissionContext, type ToolCallRendererProps } from "../../types"
import GitHubToolCallRenderer from "./GitHubRenderer"
import { actionLabel } from "./shared"

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

function card(props: Partial<ToolCallRendererProps> & { toolName: string }) {
  renderWithTamagui(
    <PermissionContext.Provider
      value={{ onGrant: vi.fn(), onGrantAlways: vi.fn(), onDeny: vi.fn(), onDenyAlways: vi.fn() }}
    >
      <GitHubToolCallRenderer toolCallId="tc" status="completed" {...props} />
    </PermissionContext.Provider>,
  )
  const header = screen.getAllByRole("button")[0]
  fireEvent.click(header)
  return document.body.textContent ?? ""
}

beforeEach(() => {
  useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("GitHub tool cards (005, 009, 010, 011)", () => {
  it("lists read the paged {items} shape", () => {
    const text = card({
      toolName: "github_list-branches",
      output: JSON.stringify({ items: [{ name: "main" }, { name: "feat/x" }], page: 1, per_page: 30, has_next_page: true }),
    })
    expect(text).toContain("feat/x")
  })

  it("issue lists read the paged {items} shape", () => {
    const text = card({
      toolName: "github_list-issues",
      output: JSON.stringify({ items: [{ number: 7, title: "Broken login", state: "open" }], page: 1, per_page: 30, has_next_page: false }),
    })
    expect(text).toContain("Broken login")
  })

  it("file content shows decoded_content", () => {
    const text = card({
      toolName: "github_get-file-content",
      output: JSON.stringify({ name: "a.txt", path: "a.txt", sha: "abc1234", size: 6, decoded_content: "hello there" }),
    })
    expect(text).toContain("hello there")
  })

  it("a binary file says so instead of showing bytes", () => {
    const text = card({
      toolName: "github_get-file-content",
      output: JSON.stringify({ name: "logo.png", path: "logo.png", sha: "abc1234", size: 2016, binary: true, encoding: "base64", content: "iVBORw0KGgo=" }),
    })
    expect(text).toMatch(/binary/i)
    expect(text).not.toContain("iVBORw0KGgo=")
  })

  it("a reused clone is not shown as created", () => {
    const text = card({
      toolName: "github_clone-repo",
      input: { owner: "acme", repo: "api" },
      output: JSON.stringify({ success: true, path: "/workspace/acme/api@agent_a", branch: "main", sha: "abc1234", reused: true }),
    })
    expect(text).toMatch(/reused/i)
    expect(text).not.toMatch(/created/i)
  })

  it("get-user shows the login, not the installation context", () => {
    const text = card({
      toolName: "github_get-user",
      output: JSON.stringify({ login: "octocat", name: "Octo Cat", type: "User", html_url: "https://github.com/octocat" }),
    })
    expect(text).toContain("@octocat")
    expect(text).not.toMatch(/installation|instalación/i)
  })
})

describe("card labels follow the UI language (010)", () => {
  it("English verbs in an English UI", () => {
    expect(actionLabel("github_list-branches", "completed")).not.toMatch(/Consultad/)
    expect(actionLabel("github_git-push", "completed", "main")).toBe("Pushed main")
  })

  it('a failed call does not end in "— 0"', () => {
    expect(actionLabel("github_list-repos", "failed", "repositories", "0")).not.toContain("— 0")
  })
})
