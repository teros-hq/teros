import { describe, expect, it } from "vitest"
import { getAvatarUrl } from "./image-url"

describe("getAvatarUrl · object URLs (OBJ)", () => {
  it("[OBJ-AC-9] an avatar served from the object URL asks for the sized variant", () => {
    expect(getAvatarUrl("https://be.example.com/objects/obj_0123456789abcdef", 28)).toBe(
      "https://be.example.com/objects/obj_0123456789abcdef?w=56&h=56&fit=cover&format=webp&q=80",
    )
  })

  it("caps the requested size at 512", () => {
    expect(getAvatarUrl("https://be.example.com/objects/obj_0123456789abcdef", 400)).toBe(
      "https://be.example.com/objects/obj_0123456789abcdef?w=512&h=512&fit=cover&format=webp&q=80",
    )
  })

  it("a static avatar keeps asking for its sized variant", () => {
    expect(getAvatarUrl("https://be.example.com/static/iria.png", 28)).toBe(
      "https://be.example.com/static/iria.png?w=56&h=56&fit=cover&format=webp&q=80",
    )
  })

  it("an external avatar is left as it is", () => {
    expect(getAvatarUrl("https://lh3.googleusercontent.com/a/photo", 28)).toBe(
      "https://lh3.googleusercontent.com/a/photo",
    )
  })
})
