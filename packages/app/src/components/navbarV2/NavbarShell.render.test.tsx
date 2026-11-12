/** navbar_v2 flag switch: off → current Navbar, on → NavbarV2. */
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const flag = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock("../../hooks/useFeatureFlag", () => ({ useFeatureFlag: () => flag.value }))
vi.mock("../Navbar", () => ({ Navbar: ({ children }: any) => <div data-testid="old">{children}</div> }))
vi.mock("./NavbarV2", () => ({ NavbarV2: ({ children }: any) => <div data-testid="v2">{children}</div> }))

import { NavbarShell } from "./NavbarShell"

describe("NavbarShell", () => {
  beforeEach(() => {
    flag.value = false
  })
  it("flag off (default) renders the current Navbar with children", () => {
    render(<NavbarShell>child</NavbarShell>)
    expect(screen.getByTestId("old").textContent).toBe("child")
    expect(screen.queryByTestId("v2")).toBeNull()
  })
  it("flag on renders NavbarV2 with children", () => {
    flag.value = true
    render(<NavbarShell>child</NavbarShell>)
    expect(screen.getByTestId("v2").textContent).toBe("child")
    expect(screen.queryByTestId("old")).toBeNull()
  })
})
