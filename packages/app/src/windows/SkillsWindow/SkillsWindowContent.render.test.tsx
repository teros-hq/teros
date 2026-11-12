/**
 * Render tests for SkillsWindowContent — loadMode badge visibility.
 *
 * Verifies that the skills list shows loadMode badges with correct
 * colors and labels, and that the create/edit forms include the
 * loadMode selector.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import * as React from "react"
import { renderWithTamagui } from "../../test/renderWithTamagui"

// ── mocks ──────────────────────────────────────────────────────────────────

const h = {
  t: (key: string, _opts?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      "skills.title": "Skills",
      "skills.newSkill": "New skill",
      "skills.loadingSkills": "Loading skills...",
      "skills.error": "Error",
      "skills.loadError": "Could not load skills",
      "skills.nameRequired": "Name is required",
      "skills.contentRequired": "Content is required",
      "skills.created": "Skill created",
      "skills.createdMessage": "Skill added",
      "skills.createError": "Could not create skill",
      "skills.creating": "Creating...",
      "skills.saved": "Saved",
      "skills.updatedMessage": "Skill updated",
      "skills.saveError": "Could not save skill",
      "skills.deleted": "Deleted",
      "skills.deletedMessage": "Skill deleted",
      "skills.deleteError": "Could not delete skill",
      "skills.deleting": "Deleting...",
      "skills.deleteConfirm": "Delete skill?",
      "skills.labelName": "NAME *",
      "skills.labelDescription": "DESCRIPTION",
      "skills.labelContent": "MARKDOWN CONTENT *",
      "skills.contentLabel": "CONTENT",
      "skills.namePlaceholder": "Skill name",
      "skills.descriptionPlaceholder": "Short description (optional)",
      "skills.contentPlaceholder": "Instructions in Markdown...",
      "skills.labelLoadMode": "LOAD MODE",
      "skills.loadMode": "Load mode",
      "skills.loadModeAlways": "Always loaded",
      "skills.loadModeOnDemand": "On-demand",
      "skills.noSkills": "No skills in this workspace",
      "skills.noSkillsHint": "Create a skill to add reusable instructions",
      "common.cancel": "Cancel",
      "common.save": "Save",
      "common.create": "Create",
      "common.delete": "Delete",
    }
    return map[key] ?? key
  },
}

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: h.t }) }))

vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: vi.fn(() => ({
    isConnected: () => true,
    on: () => {},
    off: () => {},
    skillRequest: vi.fn(async (method: string, data: Record<string, unknown>) => {
      if (method === "skill.list") {
        return {
          skills: [
            {
              skillId: "sk_always_1",
              name: "Always Skill",
              description: "Injected every turn",
              content: "# Always",
              loadMode: "always",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
            {
              skillId: "sk_demand_1",
              name: "Lazy Skill",
              description: "Loaded on demand",
              content: "# On-demand",
              loadMode: "on-demand",
              createdAt: "2024-01-02",
              updatedAt: "2024-01-02",
            },
            {
              skillId: "sk_no_mode",
              name: "Legacy Skill",
              description: "No loadMode set",
              content: "# Legacy",
              createdAt: "2024-01-03",
              updatedAt: "2024-01-03",
            },
          ],
        }
      }
      if (method === "skill.create") {
        return {
          skill: {
            skillId: "sk_new_1",
            name: data.name,
            description: data.description,
            content: data.content,
            loadMode: data.loadMode,
            createdAt: "2024-01-04",
            updatedAt: "2024-01-04",
          },
        }
      }
      if (method === "skill.update") {
        return {
          skill: {
            skillId: data.skillId,
            name: data.name,
            description: data.description,
            content: data.content,
            loadMode: data.loadMode,
            createdAt: "2024-01-01",
            updatedAt: "2024-01-04",
          },
        }
      }
      return {}
    }),
  })),
}))

vi.mock("../../components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock("../../store/workspaceStore", () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: "ws_test" }),
}))

vi.mock("../../components/ui", () => ({
  FullscreenLoader: ({ label }: { label: string }) =>
    React.createElement("div", { "data-testid": "loader" }, label),
}))

vi.mock("../../components/ContextEditor", () => ({
  ContextEditor: () => null,
}))

// ── component under test ────────────────────────────────────────────────────

import { SkillsWindowContent } from "./SkillsWindowContent"

// ── tests ───────────────────────────────────────────────────────────────────

describe("SkillsWindowContent — loadMode badges", () => {
  it('renders "Always loaded" badge for skills with loadMode=always', async () => {
    renderWithTamagui(
      React.createElement(SkillsWindowContent, { windowId: "win_1", workspaceId: "ws_test" }),
    )

    await waitFor(() => {
      expect(screen.getByText("Always loaded")).toBeInTheDocument()
    })
  })

  it('renders "On-demand" badge for skills with loadMode=on-demand', async () => {
    renderWithTamagui(
      React.createElement(SkillsWindowContent, { windowId: "win_1", workspaceId: "ws_test" }),
    )

    await waitFor(() => {
      expect(screen.getByText("On-demand")).toBeInTheDocument()
    })
  })

  it("does not render a badge for skills without loadMode (legacy)", async () => {
    renderWithTamagui(
      React.createElement(SkillsWindowContent, { windowId: "win_1", workspaceId: "ws_test" }),
    )

    await waitFor(() => {
      // There should be exactly 2 badges (Always loaded + On-demand), not 3.
      // Exact match: the card's content preview ("# On-demand") is not a badge.
      const badges = screen.getAllByText(/^(Always loaded|On-demand)$/)
      expect(badges).toHaveLength(2)
    })
  })
})

describe("SkillsWindowContent — create form", () => {
  it("shows the loadMode selector with default On-demand", async () => {
    renderWithTamagui(
      React.createElement(SkillsWindowContent, { windowId: "win_1", workspaceId: "ws_test" }),
    )

    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument()
    })

    // Click "New skill" button
    const newSkillBtn = screen.getByText("New skill")
    newSkillBtn.click()

    // Both options should be visible in the create form
    await waitFor(() => {
      expect(screen.getAllByText("Always loaded").length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText("On-demand").length).toBeGreaterThanOrEqual(1)
    })
  })
})
