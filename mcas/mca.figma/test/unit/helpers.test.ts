import { describe, expect, it } from "bun:test"
import {
  extractColorsFromNode,
  extractTypographyFromNode,
  type FigmaColor,
  type FigmaNode,
  type FigmaTypeStyle,
  formatColorsAsCss,
  formatColorsAsTailwind,
  formatTypographyAsCss,
  formatTypographyAsTailwind,
  rgbaToHex,
  simplifyNode,
} from "../../src/tools/_helpers"
import { normalizeNodeId, sanitizeNumber, validateFileKey } from "../../src/tools/utils"

describe("rgbaToHex", () => {
  it("renders opaque colors as #rrggbb", () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0 })).toBe("#ff0000")
    expect(rgbaToHex({ r: 0, g: 1, b: 0, a: 1 })).toBe("#00ff00")
    expect(rgbaToHex({ r: 0.5, g: 0.5, b: 0.5 })).toBe("#808080")
  })

  it("renders translucent colors as rgba()", () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("rgba(255, 0, 0, 0.50)")
  })
})

describe("simplifyNode", () => {
  const node: FigmaNode = {
    id: "1:2",
    name: "Hero",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 1440.4, height: 900.7 },
    fills: [
      { type: "SOLID", color: { r: 1, g: 0, b: 0 } },
      { type: "IMAGE", color: undefined }, // should be filtered out
    ],
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    strokeWeight: 2,
    cornerRadius: 8,
    children: [
      {
        id: "1:3",
        name: "Title",
        type: "TEXT",
        style: { fontFamily: "Inter", fontWeight: 600, fontSize: 24 },
      },
    ],
  }

  it("simplifies fields and rounds bounds", () => {
    const out = simplifyNode(node, 1)
    expect(out.id).toBe("1:2")
    expect(out.name).toBe("Hero")
    expect(out.type).toBe("FRAME")
    expect(out.bounds).toEqual({ width: 1440, height: 901 })
    expect(out.cornerRadius).toBe(8)
    expect(out.strokeWeight).toBe(2)
  })

  it("filters IMAGE fills and converts SOLID color", () => {
    const out = simplifyNode(node, 1)
    expect(out.fills).toHaveLength(1)
    expect(out.fills?.[0].color).toBe("#ff0000")
  })

  it("descends children up to depth, then reports childCount", () => {
    const deep = simplifyNode(node, 2)
    expect(deep.children).toHaveLength(1)
    expect(deep.children?.[0].name).toBe("Title")
    const shallow = simplifyNode(node, 0)
    expect(shallow.children).toBeUndefined()
    expect(shallow.childCount).toBe(1)
  })

  it("preserves textStyle on TEXT nodes", () => {
    const out = simplifyNode(node, 1)
    expect(out.children?.[0].textStyle).toEqual({
      fontFamily: "Inter",
      fontSize: 24,
      fontWeight: 600,
      lineHeight: undefined,
      letterSpacing: undefined,
    })
  })
})

describe("extractColorsFromNode", () => {
  it("collects unique solid fills + strokes (recursive)", () => {
    const tree: FigmaNode = {
      id: "1",
      name: "root",
      type: "FRAME",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      children: [
        {
          id: "2",
          name: "child",
          type: "RECTANGLE",
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], // duplicate
          strokes: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }],
        },
      ],
    }
    const colors = new Map<string, FigmaColor>()
    extractColorsFromNode(tree, colors)
    expect(colors.size).toBe(2)
    expect(colors.has("#ff0000")).toBe(true)
    expect(colors.has("#00ff00")).toBe(true)
  })
})

describe("extractTypographyFromNode", () => {
  it("collects unique TEXT styles, dedupes by family-size-weight", () => {
    const tree: FigmaNode = {
      id: "1",
      name: "root",
      type: "FRAME",
      children: [
        {
          id: "2",
          name: "h1",
          type: "TEXT",
          style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700 },
        },
        {
          id: "3",
          name: "h2",
          type: "TEXT",
          style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700 },
        },
        {
          id: "4",
          name: "body",
          type: "TEXT",
          style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
        },
      ],
    }
    const styles = new Map<string, FigmaTypeStyle>()
    extractTypographyFromNode(tree, styles)
    expect(styles.size).toBe(2)
  })
})

describe("formatters", () => {
  it("formatColorsAsCss writes :root vars", () => {
    expect(formatColorsAsCss(["#ff0000", "#00ff00"])).toBe(
      ":root {\n  --color-1: #ff0000;\n  --color-2: #00ff00;\n}",
    )
  })

  it("formatColorsAsTailwind writes JS object literal", () => {
    expect(formatColorsAsTailwind(["#ff0000"])).toContain('"color-1": "#ff0000"')
  })

  it("formatTypographyAsCss writes class blocks", () => {
    const css = formatTypographyAsCss([
      { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24 },
    ])
    expect(css).toContain(".text-style-1")
    expect(css).toContain('font-family: "Inter"')
    expect(css).toContain("font-size: 16px")
    expect(css).toContain("line-height: 24px")
  })

  it("formatTypographyAsTailwind falls back to fontSize*1.5 when lineHeight missing", () => {
    const out = formatTypographyAsTailwind([{ fontFamily: "Inter", fontSize: 16, fontWeight: 400 }])
    expect(out).toContain('lineHeight: "24px"')
  })
})

describe("input validators", () => {
  it("validateFileKey accepts valid keys", () => {
    expect(validateFileKey("aBc123_-XYZ")).toBe("aBc123_-XYZ")
    expect(validateFileKey("  trim-me  ")).toBe("trim-me")
  })

  it("validateFileKey rejects empty / invalid chars", () => {
    expect(() => validateFileKey("")).toThrow("must be a non-empty string")
    expect(() => validateFileKey("   ")).toThrow("must be a non-empty string")
    expect(() => validateFileKey("a/b")).toThrow("invalid characters")
    expect(() => validateFileKey("javascript:alert(1)")).toThrow("invalid characters")
  })

  it("normalizeNodeId converts URL form to REST form", () => {
    expect(normalizeNodeId("1-2")).toBe("1:2")
    expect(normalizeNodeId("1:2")).toBe("1:2")
    expect(normalizeNodeId("12-34-56")).toBe("12:34:56")
  })

  it("normalizeNodeId rejects empty", () => {
    expect(() => normalizeNodeId("")).toThrow("must be a non-empty string")
  })

  it("sanitizeNumber clamps to range", () => {
    expect(sanitizeNumber(5, { min: 1, max: 10, default: 2 })).toBe(5)
    expect(sanitizeNumber(0, { min: 1, max: 10, default: 2 })).toBe(1)
    expect(sanitizeNumber(99, { min: 1, max: 10, default: 2 })).toBe(10)
    expect(sanitizeNumber("not a number", { min: 1, max: 10, default: 2 })).toBe(2)
    expect(sanitizeNumber(undefined, { min: 1, max: 10, default: 2 })).toBe(2)
  })

  it("sanitizeNumber integer flag floors", () => {
    expect(sanitizeNumber(3.7, { min: 1, max: 10, default: 2, integer: true })).toBe(3)
    expect(sanitizeNumber(3.7, { min: 1, max: 10, default: 2 })).toBe(3.7)
  })
})
