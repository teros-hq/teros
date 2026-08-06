/**
 * Regression test for the audit goal: mca.figma responses must not destroy
 * the agent's context window.
 *
 * The Figma REST API returns deeply nested documents (full node trees with
 * fills, strokes, effects, blendMode, layoutAlign, etc.). The curated paths
 * in `_fields.ts` and the `simplifyNode` helper exist to keep the LLM payload
 * tractable. These tests measure the reduction.
 */

import { describe, expect, it } from "bun:test"
import { COMMENT_FIELDS, COMPONENT_FIELDS, STYLE_FIELDS } from "../../src/tools/_fields"
import { type FigmaFile, type FigmaNode, simplifyNode } from "../../src/tools/_helpers"
import { pickFieldsList } from "../../src/tools/utils"

function makeBigNode(id: string, depth: number, breadth: number): FigmaNode {
  const node: FigmaNode = {
    id,
    name: `Node ${id}`,
    type: depth === 0 ? "TEXT" : "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
    cornerRadius: 8,
    strokeWeight: 2,
    fills: [
      { type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } },
      { type: "IMAGE" },
      { type: "GRADIENT_LINEAR", color: { r: 0.5, g: 0.5, b: 0.5 } },
    ],
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    effects: [
      {
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.1 },
        offset: { x: 0, y: 4 },
        radius: 8,
      },
      {
        type: "INNER_SHADOW",
        color: { r: 1, g: 1, b: 1, a: 0.5 },
        offset: { x: 0, y: 1 },
        radius: 1,
      },
    ] as any,
    style:
      depth === 0
        ? { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24 }
        : undefined,
  }
  if (depth > 0) {
    node.children = Array.from({ length: breadth }, (_, i) =>
      makeBigNode(`${id}.${i}`, depth - 1, breadth),
    )
  }
  return node
}

describe("context-size regression — get-file document tree", () => {
  it("simplifyNode at depth 2 is ≥ 60% smaller than raw at depth 4", () => {
    // Raw: depth=4, breadth=3 → 1 + 3 + 9 + 27 + 81 = 121 nodes with verbose fields.
    const raw: FigmaNode = makeBigNode("1:0", 4, 3)
    // Curated: simplifyNode keeps the renderer-relevant fields and stops at depth 2.
    const curated = simplifyNode(raw, 2)

    const rawSize = JSON.stringify(raw).length
    const curatedSize = JSON.stringify(curated).length
    const ratio = curatedSize / rawSize

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] get-file doc raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    )

    expect(ratio).toBeLessThanOrEqual(0.4)
  })
})

describe("context-size regression — list comments", () => {
  function makeCommentRaw(i: number) {
    return {
      id: `comment-${i}-uuid-0000`,
      message: `Comment ${i}: this is a sample comment with some realistic length so the JSON body has weight.`,
      file_key: "abcDEF123456",
      parent_id: i % 3 === 0 ? `comment-${i - 1}-uuid` : undefined,
      user: {
        handle: `user${i % 5}`,
        img_url: `https://cdn.figma.com/avatar/${i % 5}.png`,
        id: `u-${i}`,
      },
      created_at: new Date(2026, 3, 1, 10, i % 60, 0).toISOString(),
      resolved_at: i % 4 === 0 ? new Date(2026, 3, 2, 10, 0, 0).toISOString() : null,
      reactions: [
        { user_id: "u1", emoji: "🎉" },
        { user_id: "u2", emoji: "👍" },
      ],
      client_meta: { x: i * 10, y: i * 5, node_id: `1:${i}` },
      order_id: i,
    }
  }

  it("curated default ≥ 40% smaller than raw", () => {
    // Note: comments have a high content/wrapper ratio — `message` is real user
    // content that we cannot trim. The reduction comes from dropping reactions,
    // file_key, order_id, and the user.img_url + user.id sub-fields. Empirically
    // ~43%; threshold set conservatively at 40%.
    const raw = Array.from({ length: 30 }, (_, i) => makeCommentRaw(i))
    const shaped = raw.map((c) => ({
      id: c.id,
      message: c.message,
      createdAt: c.created_at,
      user: c.user.handle,
      resolved: c.resolved_at != null,
      parentId: c.parent_id,
      clientMeta: c.client_meta,
    }))
    const curated = pickFieldsList(shaped as any, [...COMMENT_FIELDS])

    const rawSize = JSON.stringify(raw).length
    const curatedSize = JSON.stringify(curated).length
    const ratio = curatedSize / rawSize

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] get-comments raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    )

    expect(ratio).toBeLessThanOrEqual(0.6)
  })
})

describe("context-size regression — list components & styles", () => {
  it("get-components curated default ≥ 40% smaller than raw", () => {
    const raw = Array.from({ length: 40 }, (_, i) => ({
      id: `c-${i}`,
      key: `key-${i}-with-uuid-suffix-9876`,
      file_key: "abcDEF123456",
      node_id: `1:${i}`,
      thumbnail_url: `https://cdn.figma.com/thumb/${i}.png`,
      name: `Component ${i}`,
      description:
        "Multi-line description with usage notes, accessibility info, and changelog entries.",
      componentSetId: i % 3 === 0 ? `set-${i % 3}` : null,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-10T10:00:00Z",
      user: { id: `u-${i}`, handle: `user${i % 5}`, img_url: `https://cdn/${i}.png` },
      remote: false,
    }))
    const shaped = raw.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      description: c.description,
      componentSetId: c.componentSetId,
    }))
    const curated = pickFieldsList(shaped as any, [...COMPONENT_FIELDS])

    const rawSize = JSON.stringify(raw).length
    const curatedSize = JSON.stringify(curated).length
    const ratio = curatedSize / rawSize

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] get-components raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    )

    expect(ratio).toBeLessThanOrEqual(0.6)
  })

  it("get-file-styles curated default ≥ 30% smaller than raw", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({
      id: `s-${i}`,
      key: `style-key-${i}-uuid-suffix-${i}`,
      file_key: "abcDEF123456",
      node_id: `1:${i}`,
      styleType: ["FILL", "TEXT", "EFFECT", "GRID"][i % 4],
      name: `Style ${i}`,
      description: "Style description with cross-team usage notes",
      sortPosition: i,
      remote: false,
    }))
    const shaped = raw.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      type: s.styleType,
      description: s.description,
    }))
    const curated = pickFieldsList(shaped as any, [...STYLE_FIELDS])

    const rawSize = JSON.stringify(raw).length
    const curatedSize = JSON.stringify(curated).length
    const ratio = curatedSize / rawSize

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] get-file-styles raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(3)} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    )

    expect(ratio).toBeLessThanOrEqual(0.7)
  })
})

// Sanity: the helper sub-tree used by simplifyNode is exercised by helpers.test.ts;
// here we only check the cumulative payload reduction the LLM actually sees.
function _typecheck(_: FigmaFile) {
  // ensure FigmaFile import doesn't get removed by linter
}
