import { type ReactNode, useState } from "react"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds/Icon"
import { T } from "../ui/ds/Text"

export interface Column<T> {
  key: string
  header: string
  /** Fixed column width in px — the min-width contract that keeps columns from collapsing. */
  width: number
  /**
   * Flex-grow weight to absorb extra viewport width (proportional). Default 0 =
   * fixed. Give it to the text-heavy column(s) so the table fills the window
   * instead of ending mid-screen; `width` stays as the min-width floor. For
   * STACKED tables that must keep leading columns aligned, flex only the LAST
   * column of each.
   */
  flex?: number
  align?: "left" | "right" | "center"
  /** Cell content. Return a plain string for a default mono/right-aligned number cell,
   *  or a node for custom cells (status dot, model+provider, bars…). */
  render: (row: T) => ReactNode
  /** Force monospace + a color on a plain-string cell. */
  mono?: boolean
  color?: (row: T) => string
  /** Makes the header cell a sort toggle (asc → desc → none). Requires `sortValue`. */
  sortable?: boolean
  /** The comparable value for this column when sorting (numbers sort numerically, strings via localeCompare). */
  sortValue?: (row: T) => string | number
}

/** Active sort: which column key + direction (1 = ascending, -1 = descending). */
type SortState = { key: string; dir: 1 | -1 } | null

/** Sort a COPY of `rows` by the active column's `sortValue`. Untouched (same order) when no sort is active. */
function sortRows<T>(rows: T[], sort: SortState, columns: Column<T>[]): T[] {
  if (!sort) return rows
  const col = columns.find((c) => c.key === sort.key)
  if (!col?.sortValue) return rows
  const getValue = col.sortValue
  return [...rows].sort((a, b) => {
    const av = getValue(a)
    const bv = getValue(b)
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv))
    return cmp * sort.dir
  })
}

/** Cycle a column's sort: inactive → asc → desc → off. */
function nextSort(sort: SortState, key: string): SortState {
  if (!sort || sort.key !== key) return { key, dir: 1 }
  if (sort.dir === 1) return { key, dir: -1 }
  return null
}

const JC = { left: "flex-start", right: "flex-end", center: "center" } as const

/** Sizing style for a cell/header cell: fixed width, or flex with min-width floor. */
function cellSize<T>(col: Column<T>) {
  return col.flex
    ? { flexGrow: col.flex, flexShrink: 0, flexBasis: col.width, minWidth: col.width }
    : { width: col.width, minWidth: col.width, flexShrink: 0 }
}

function Cell<T>({ col, row }: { col: Column<T>; row: T }) {
  const c = useColors()
  const content = col.render(row)
  const node =
    typeof content === "string" ? (
      <T
        step={col.mono === false ? "sm" : "code"}
        color={col.color ? col.color(row) : c.text2}
        numberOfLines={1}
        style={{ textAlign: col.align ?? "left", width: "100%" }}
      >
        {content}
      </T>
    ) : (
      content
    )
  return (
    <View
      style={[
        cellSize(col),
        { flexDirection: "row", alignItems: "center", justifyContent: JC[col.align ?? "left"] },
      ]}
    >
      {node}
    </View>
  )
}

const CARET_W = 22
/** Horizontal gap between columns — without it a right-aligned numeric cell
 *  glues to the next left-aligned one ("0.00completed"). Counted in minWidth. */
const COL_GAP = 12

const KEY_ACTIVATE = (fn: () => void) => (e: { key: string; preventDefault: () => void }) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    fn()
  }
}

/**
 * Solid, scrollable data table drawn as the OS prototype's `LGroup`: one card
 * on the sheet, codenote column headers, hairline-separated rows that wash on
 * hover. Fixed per-column min-widths + a single horizontal scroll (so many
 * columns scroll instead of crushing), single-line ellipsized cells, and
 * headers that never wrap. The content STRETCHES to the viewport (`flexGrow`
 * on the scroll content) so a table never ends mid-screen — mark which columns
 * absorb the extra width via `Column.flex`.
 *
 * `renderExpanded` turns rows into disclosure rows (caret + Enter/Space +
 * aria-expanded): pressing toggles an inline detail panel — put drill buttons
 * (e.g. "View trace →") INSIDE the detail. Without it, `onRowPress` drills
 * directly on press.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowPress,
  renderExpanded,
  header = true,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, i: number) => string
  onRowPress?: (row: T) => void
  /** Inline expandable detail per row — wins over `onRowPress` for the row press. */
  renderExpanded?: (row: T) => ReactNode
  header?: boolean
}) {
  const c = useColors()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const displayRows = sortRows(rows, sort, columns)
  const expandable = !!renderExpanded
  const cellCount = columns.length + (expandable ? 1 : 0)
  const minWidth =
    columns.reduce((a, col) => a + col.width, expandable ? CARET_W : 0) +
    COL_GAP * Math.max(0, cellCount - 1)
  const web = Platform.OS === "web"

  return (
    <View
      style={[
        { borderRadius: 16, backgroundColor: c.bgStep, overflow: "hidden" },
        web ? ({ boxShadow: c.liftSm } as any) : null,
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        // Stretch the content to the viewport when it's wider than the columns —
        // without this the table ends at sum(width) and leaves the right half of
        // the window empty. When the viewport is NARROWER, minWidth keeps the
        // columns solid and the horizontal scroll kicks in.
        contentContainerStyle={{ flexGrow: 1 }}
        style={
          web
            ? ({ scrollbarWidth: "thin", scrollbarColor: `${c.borderStrong} transparent` } as any)
            : undefined
        }
      >
        <View style={{ minWidth, flex: 1 }}>
          {header && (
            <View
              style={{
                flexDirection: "row",
                paddingVertical: 10,
                paddingHorizontal: 16,
                gap: COL_GAP,
                borderBottomWidth: 1,
                borderBottomColor: c.border,
              }}
            >
              {expandable ? (
                <View style={{ width: CARET_W, minWidth: CARET_W, flexShrink: 0 }} />
              ) : null}
              {columns.map((col) => {
                const label = (
                  <T
                    step="codenote"
                    tone="text3"
                    numberOfLines={1}
                    style={{ textAlign: col.align ?? "left" }}
                  >
                    {col.header}
                  </T>
                )
                if (!col.sortable) {
                  return (
                    <View
                      key={col.key}
                      style={[
                        cellSize(col),
                        { flexDirection: "row", justifyContent: JC[col.align ?? "left"] },
                      ]}
                    >
                      {label}
                    </View>
                  )
                }
                const isActive = sort?.key === col.key
                const toggleSort = () => setSort((s) => nextSort(s, col.key))
                return (
                  <Pressable
                    key={col.key}
                    onPress={toggleSort}
                    accessibilityRole="button"
                    style={[
                      cellSize(col),
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        justifyContent: JC[col.align ?? "left"],
                      },
                      web ? ({ cursor: "pointer" } as any) : null,
                    ]}
                    {...({
                      role: "button",
                      tabIndex: 0,
                      "aria-sort": isActive
                        ? sort?.dir === 1
                          ? "ascending"
                          : "descending"
                        : "none",
                      onKeyDown: KEY_ACTIVATE(toggleSort),
                    } as any)}
                  >
                    {label}
                    {isActive ? (
                      <Ph
                        name={sort?.dir === 1 ? "caret-up" : "caret-down"}
                        size={10}
                        color={c.text2}
                      />
                    ) : null}
                  </Pressable>
                )
              })}
            </View>
          )}
          {displayRows.map((row, i) => {
            const key = rowKey(row, i)
            const isExpanded = expandable && expandedKey === key
            const toggle = () => setExpandedKey(isExpanded ? null : key)
            const cells = columns.map((col) => <Cell key={col.key} col={col} row={row} />)
            const pressable = expandable || !!onRowPress
            const onPress = expandable ? toggle : () => onRowPress?.(row)
            const rowStyle = [
              {
                flexDirection: "row" as const,
                alignItems: "center" as const,
                paddingVertical: 10,
                paddingHorizontal: 16,
                gap: COL_GAP,
                borderTopWidth: i > 0 || header ? 1 : 0,
                borderTopColor: c.border,
                backgroundColor: hoverKey === key ? c.nestHover : "transparent",
              },
              web
                ? ({
                    cursor: pressable ? "pointer" : "default",
                    transition: "background 0.25s",
                  } as any)
                : null,
            ]
            const hoverProps = web
              ? {
                  onHoverIn: () => setHoverKey(key),
                  onHoverOut: () => setHoverKey((k) => (k === key ? null : k)),
                }
              : {}
            return (
              <View key={key}>
                {pressable ? (
                  <Pressable
                    onPress={onPress}
                    style={rowStyle}
                    {...hoverProps}
                    {...(expandable
                      ? ({
                          role: "button",
                          tabIndex: 0,
                          "aria-expanded": isExpanded,
                          onKeyDown: KEY_ACTIVATE(toggle),
                        } as any)
                      : {})}
                  >
                    {expandable ? (
                      <View style={{ width: CARET_W, minWidth: CARET_W, flexShrink: 0 }}>
                        <Ph
                          name={isExpanded ? "caret-down" : "caret-right"}
                          size={11}
                          color={c.text3}
                        />
                      </View>
                    ) : null}
                    {cells}
                  </Pressable>
                ) : (
                  <View style={rowStyle}>{cells}</View>
                )}
                {isExpanded ? (
                  <View
                    style={{
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      paddingLeft: CARET_W + 16,
                      gap: 8,
                      backgroundColor: c.nest,
                      borderTopWidth: 1,
                      borderTopColor: c.border,
                    }}
                  >
                    {renderExpanded?.(row)}
                  </View>
                ) : null}
              </View>
            )
          })}
        </View>
      </ScrollView>
    </View>
  )
}
