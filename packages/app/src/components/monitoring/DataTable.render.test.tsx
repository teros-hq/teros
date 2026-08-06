import { fireEvent } from "@testing-library/react"
import { Text } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { type Column, DataTable } from "./DataTable"

interface Row {
  model: string
  p95: number
  status: string
}

const rows: Row[] = [
  { model: "claude-opus-4.1", p95: 2380, status: "ok" },
  { model: "o3", p95: 5200, status: "warn" },
]

const columns: Column<Row>[] = [
  { key: "model", header: "Model", width: 240, align: "left", render: (r) => r.model },
  {
    key: "p95",
    header: "p95",
    width: 88,
    align: "right",
    mono: true,
    render: (r) => `${r.p95} ms`,
  },
  {
    key: "status",
    header: "Status",
    width: 44,
    align: "center",
    render: (r) => <Text testID={`st-${r.status}`}>{r.status}</Text>,
  },
]

describe("DataTable", () => {
  it("renders every header once", () => {
    const { getByText } = renderWithTamagui(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.model} />,
    )
    expect(getByText("Model")).toBeTruthy()
    expect(getByText("p95")).toBeTruthy()
    expect(getByText("Status")).toBeTruthy()
  })

  it("renders a string cell verbatim (exact value, not just 'called')", () => {
    const { getByText } = renderWithTamagui(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.model} />,
    )
    expect(getByText("claude-opus-4.1")).toBeTruthy()
    expect(getByText("5200 ms")).toBeTruthy() // second row's exact p95 cell
  })

  it("renders a custom node cell (status column) per row", () => {
    const { getByTestId } = renderWithTamagui(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.model} />,
    )
    expect(getByTestId("st-ok")).toBeTruthy()
    expect(getByTestId("st-warn")).toBeTruthy()
  })

  it("omits the header row when header={false}", () => {
    const { queryByText, getByText } = renderWithTamagui(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.model} header={false} />,
    )
    expect(queryByText("Model")).toBeNull() // header gone
    expect(getByText("claude-opus-4.1")).toBeTruthy() // rows still there
  })
})

describe("DataTable — expandable rows (renderExpanded)", () => {
  it("toggles the inline detail on row press and marks aria-expanded", () => {
    const { getByText, queryByText, getAllByRole } = renderWithTamagui(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.model}
        renderExpanded={(r) => <Text>{`detail-${r.model}`}</Text>}
      />,
    )
    expect(queryByText("detail-o3")).toBeNull() // collapsed by default

    const row = getByText("o3").closest('[role="button"]')!
    fireEvent.click(row)
    expect(getByText("detail-o3")).toBeTruthy() // detail visible
    expect(row.getAttribute("aria-expanded")).toBe("true")
    expect(queryByText("detail-claude-opus-4.1")).toBeNull() // only the pressed row

    fireEvent.click(row) // second press collapses
    expect(queryByText("detail-o3")).toBeNull()
    // Both rows are keyboard-reachable disclosure buttons.
    expect(getAllByRole("button").length).toBe(2)
  })

  it("renderExpanded wins over onRowPress (drill lives inside the detail)", () => {
    const drill = vi.fn()
    const { getByText } = renderWithTamagui(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.model}
        onRowPress={drill}
        renderExpanded={(r) => <Text>{`detail-${r.model}`}</Text>}
      />,
    )
    fireEvent.click(getByText("o3").closest('[role="button"]')!)
    expect(getByText("detail-o3")).toBeTruthy()
    expect(drill).not.toHaveBeenCalled()
  })
})

describe("DataTable — sortable columns", () => {
  interface SRow {
    k: string
    v: number
  }
  // Default order is intentionally NOT ascending by `v` (x=3 before y=1), so a
  // working comparator MUST reorder — a broken one (returns 0) leaves [x, y].
  const srows: SRow[] = [
    { k: "x", v: 3 },
    { k: "y", v: 1 },
  ]
  const scols: Column<SRow>[] = [
    { key: "k", header: "K", width: 80, render: (r) => <Text testID="kcell">{r.k}</Text> },
    {
      key: "v",
      header: "V",
      width: 80,
      align: "right",
      sortable: true,
      sortValue: (r) => r.v,
      render: (r) => `${r.v}`,
    },
  ]

  it("reorders rows ascending by sortValue when a sortable header is pressed", () => {
    const { getByText, getAllByTestId } = renderWithTamagui(
      <DataTable columns={scols} rows={srows} rowKey={(r) => r.k} />,
    )
    // Byte-identical starting order (no sort active).
    expect(getAllByTestId("kcell").map((n) => n.textContent)).toEqual(["x", "y"])

    const header = getByText("V").closest('[role="button"]')!
    fireEvent.click(header) // asc → sort by v → y(1), x(3)
    expect(getAllByTestId("kcell").map((n) => n.textContent)).toEqual(["y", "x"])
    expect(header.getAttribute("aria-sort")).toBe("ascending")

    fireEvent.click(header) // desc → x(3), y(1)
    expect(getAllByTestId("kcell").map((n) => n.textContent)).toEqual(["x", "y"])
    expect(header.getAttribute("aria-sort")).toBe("descending")

    fireEvent.click(header) // off → back to the input order
    expect(getAllByTestId("kcell").map((n) => n.textContent)).toEqual(["x", "y"])
    expect(header.getAttribute("aria-sort")).toBe("none")
  })
})
