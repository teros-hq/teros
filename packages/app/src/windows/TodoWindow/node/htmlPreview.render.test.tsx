/**
 * To Do — HTML outputs and inputs render in a sandboxed iframe in place
 * (docs/specs/todo/output-window.md, TODOOV-REQ-9 / TODOOV-AC-10).
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/htmlPreview
 */
import { fireEvent } from "@testing-library/react"
import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { NodeDetail, NodeIO } from "../model/types"
import { IOBody } from "./IOBlocks"
import { OutputTab } from "./OutputTab"

vi.mock("./pdfPage", () => ({ renderPdfFirstPage: async () => "data:image/png;base64,AAAA" }))

const URL_HTML = "http://localhost:10101/objects/obj_html"

function fileIO(name: string, mime: string, url = URL_HTML): Extract<NodeIO, { format: "file" }> {
  return { format: "file", objectId: "obj_1", url, name, mime, size: 2048 }
}

function detail(output: NodeIO): NodeDetail {
  return {
    nodeId: "n1", parentId: null, text: "Quarterly report", description: "", instructions: "", kind: "task", state: "review",
    blockedReason: null, allowedTransitions: [], progress: null, reportedProgress: null, input: null, output,
    hasInput: false, hasOutput: true, plannedFor: null, dayOrder: null, plannedTime: null,
    assignee: { kind: "user", id: "u1" }, assignedAt: null, completed: false, collapsed: false, position: 0, log: [],
    createdAt: 0, updatedAt: 0,
  }
}

function renderOutput(output: NodeIO) {
  const noop = () => {}
  return renderWithTamagui(
    <OutputTab
      node={detail(output)}
      deliveredAt={null}
      wide
      uploading={false}
      onOutput={noop}
      onExpectedOutput={noop}
      onFill={noop}
      onFormPatch={noop}
      onFormSave={noop}
      onOpen={noop}
    />,
  )
}

afterEach(() => vi.restoreAllMocks())

describe("TodoWindow — HTML file io", () => {
  it("[TODOOV-AC-10] a report.html output renders a sandboxed iframe (allow-scripts only, no allow-same-origin) with the object URL; Open opens a new tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const r = renderOutput(fileIO("report.html", "application/octet-stream"))
    const frames = r.container.querySelectorAll("iframe")
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    // opaque origin: never combine allow-scripts with allow-same-origin (sandbox escape)
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(frame.getAttribute("src")).toBe(URL_HTML)
    expect(frame.getAttribute("title")).toBe("report.html")
    fireEvent.click(r.getByRole("button", { name: /^Open$/ }))
    expect(open).toHaveBeenCalledWith(URL_HTML, "_blank", "noopener")
  })

  it("[TODOOV-AC-10] a text/html mime renders the iframe whatever the name", () => {
    const r = renderOutput(fileIO("export.out", "text/html; charset=utf-8"))
    const frame = r.container.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame?.getAttribute("src")).toBe(URL_HTML)
  })

  it("[TODOOV-AC-10] a .pdf output does not render the iframe", async () => {
    const r = renderOutput(fileIO("report.pdf", "application/pdf", "http://localhost:10101/objects/obj_pdf"))
    await r.findByLabelText("report.pdf")
    expect(r.container.querySelector("iframe")).toBeNull()
  })

  it("[TODOOV-AC-10] an HTML input (the Input block and summary blocks) renders the sandboxed iframe too", () => {
    const r = renderWithTamagui(<IOBody io={fileIO("brief.htm", "text/plain")} />)
    const frame = r.container.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame?.getAttribute("src")).toBe(URL_HTML)
    expect(r.getByText("brief.htm")).toBeTruthy()
  })
})
