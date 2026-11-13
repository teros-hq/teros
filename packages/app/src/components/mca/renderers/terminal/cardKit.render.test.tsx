import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fireEvent, render, screen } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import config from "../../../../../tamagui.config"
import { surface } from "../../primitives/colors"
import { CardButton, type CardPalette, CardShell, useCardPalette } from "./cardKit"

function paletteIn(theme: "light" | "dark"): CardPalette {
  let seen: CardPalette | null = null
  function Probe() {
    seen = useCardPalette()
    return null
  }
  const { unmount } = render(
    <TamaguiProvider config={config} defaultTheme={theme}>
      <Probe />
    </TamaguiProvider>,
  )
  unmount()
  return seen as unknown as CardPalette
}

describe("the terminal cards use the app's colour tokens [TW-AC-8]", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`in ${theme}, every colour of the card is a token of that theme`, () => {
      const p = paletteIn(theme)
      const c = surface[theme]
      expect(p).toEqual({
        bg: c.nest,
        border: c.border,
        text: c.text,
        title: c.text,
        muted: c.text3,
        accent: c.accent,
        code: c.field,
        codeBorder: c.border,
        btn: c.bgInner,
        btnBorder: c.borderStrong,
        btnText: c.text,
        pri: c.inkPill,
        priText: c.inkPillText,
        danger: c.tint.r.tx,
      })
    })
  }

  it("light and dark are different palettes", () => {
    expect(paletteIn("light").bg).not.toBe(paletteIn("dark").bg)
    expect(paletteIn("light").pri).not.toBe(paletteIn("dark").pri)
  })

  it("the card kit has no colour of its own: no hex and no rgb() in its source", () => {
    const source = readFileSync(resolve(__dirname, "cardKit.tsx"), "utf8")
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/rgba?\(/)
  })
})

describe("CardShell and CardButton", () => {
  it("the shell draws the card on the token fill and border", () => {
    render(
      <TamaguiProvider config={config} defaultTheme="light">
        <CardShell testID="shell" active>
          <CardButton testID="go" onPress={() => {}}>
            Go
          </CardButton>
        </CardShell>
      </TamaguiProvider>,
    )
    const shell = screen.getByTestId("shell")
    expect(shell.style.backgroundColor).toBe("rgba(52, 47, 61, 0.04)")
    expect(shell.style.opacity).toBe("1")
  })

  it("a button presses, and a disabled one does not", () => {
    const press = vi.fn()
    render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <CardButton testID="on" primary onPress={press}>
          Allow
        </CardButton>
        <CardButton testID="off" disabled onPress={press}>
          Keep off
        </CardButton>
      </TamaguiProvider>,
    )
    fireEvent.click(screen.getByTestId("on"))
    fireEvent.click(screen.getByTestId("off"))
    expect(press).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("on").textContent).toBe("Allow")
  })
})
