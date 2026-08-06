import { type ReactNode, useState } from "react"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { scrollbarThin, tokens } from "./colors"

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

/** Sizing props for a cell/header cell: fixed width, or flex with min-width floor. */
function cellSize<T>(col: Column<T>) {
  return col.flex
    ? { flexGrow: col.flex, flexShrink: 0, flexBasis: col.width, minWidth: col.width }
    : { width: col.width, minWidth: col.width, flexShrink: 0 }
}

function Cell<T>({ col, row }: { col: Column<T>; row: T }) {
  const content = col.render(row)
  const node =
    typeof content === "string" ? (
      <Text
        fontSize={12}
        fontFamily={col.mono === false ? "$body" : "$mono"}
        color={col.color ? col.color(row) : tokens.textSecondary}
        numberOfLines={1}
        ellipsizeMode="tail"
        textAlign={col.align ?? "left"}
        width="100%"
      >
        {content}
      </Text>
    ) : (
      content
    )
  return (
    <XStack {...cellSize(col)} ai="center" jc={JC[col.align ?? "left"]}>
      {node}
    </XStack>
  )
}

const CARET_W = 22
/** Horizontal gap between columns — without it a right-aligned numeric cell
 *  glues to the next left-aligned one ("0.00completed"). Counted in minWidth. */
const COL_GAP = 12

/**
 * Solid, scrollable data table — the fix for the Model Health tables that collapsed.
 * Fixed per-column min-widths + a single horizontal scroll (so many columns scroll
 * instead of crushing), single-line ellipsized cells, and headers that never wrap.
 * The content STRETCHES to the viewport (`flexGrow` on the scroll content) so a
 * table never ends mid-screen — mark which columns absorb the extra width via
 * `Column.flex`. Stack two tables with the SAME leading columns (flex only on the
 * last one) and their leading columns stay aligned.
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
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>(null)
  const displayRows = sortRows(rows, sort, columns)
  const expandable = !!renderExpanded
  const cellCount = columns.length + (expandable ? 1 : 0)
  const minWidth =
    columns.reduce((a, c) => a + c.width, expandable ? CARET_W : 0) +
    COL_GAP * Math.max(0, cellCount - 1)

  return (
    <YStack borderWidth={1} borderColor={tokens.border} borderRadius={12} overflow="hidden">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        // Stretch the content to the viewport when it's wider than the columns —
        // without this the table ends at sum(width) and leaves the right half of
        // the window empty. When the viewport is NARROWER, minWidth keeps the
        // columns solid and the horizontal scroll kicks in.
        contentContainerStyle={{ flexGrow: 1 }}
        // @ts-expect-error — RN-Web thin scrollbar (Teros standard)
        style={scrollbarThin}
      >
        <YStack minWidth={minWidth} flex={1}>
          {header && (
            <XStack
              paddingVertical={9}
              paddingHorizontal={12}
              gap={COL_GAP}
              backgroundColor={tokens.gray800}
              borderBottomWidth={1}
              borderBottomColor={tokens.border}
            >
              {expandable ? <XStack width={CARET_W} minWidth={CARET_W} flexShrink={0} /> : null}
              {columns.map((c) => {
                const label = (
                  <Text
                    fontSize={10}
                    fontWeight="600"
                    letterSpacing={0.5}
                    textTransform="uppercase"
                    color={tokens.textTertiary}
                    numberOfLines={1}
                    textAlign={c.align ?? "left"}
                  >
                    {c.header}
                  </Text>
                )
                if (!c.sortable) {
                  return (
                    <XStack key={c.key} {...cellSize(c)} jc={JC[c.align ?? "left"]}>
                      {label}
                    </XStack>
                  )
                }
                const isActive = sort?.key === c.key
                const toggleSort = () => setSort((s) => nextSort(s, c.key))
                return (
                  <XStack
                    key={c.key}
                    {...cellSize(c)}
                    ai="center"
                    gap={4}
                    jc={JC[c.align ?? "left"]}
                    cursor="pointer"
                    hoverStyle={{ opacity: 0.75 }}
                    onPress={toggleSort}
                    {...({
                      role: "button",
                      tabIndex: 0,
                      "aria-sort": isActive
                        ? sort?.dir === 1
                          ? "ascending"
                          : "descending"
                        : "none",
                      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          toggleSort()
                        }
                      },
                    } as any)}
                  >
                    {label}
                    {isActive ? (
                      <Text fontSize={9} color={tokens.textSecondary} aria-hidden>
                        {sort?.dir === 1 ? "▲" : "▼"}
                      </Text>
                    ) : null}
                  </XStack>
                )
              })}
            </XStack>
          )}
          {displayRows.map((row, i) => {
            const key = rowKey(row, i)
            const isExpanded = expandable && expandedKey === key
            const toggle = () => setExpandedKey(isExpanded ? null : key)
            const cells = columns.map((c) => <Cell key={c.key} col={c} row={row} />)
            const pressable = expandable || !!onRowPress
            const rowProps = pressable
              ? {
                  cursor: "pointer" as const,
                  onPress: expandable ? toggle : () => onRowPress?.(row),
                  ...(expandable
                    ? ({
                        role: "button",
                        tabIndex: 0,
                        "aria-expanded": isExpanded,
                        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            toggle()
                          }
                        },
                      } as any)
                    : {}),
                }
              : {}
            return (
              <YStack key={key}>
                <XStack
                  paddingVertical={8}
                  paddingHorizontal={12}
                  gap={COL_GAP}
                  ai="center"
                  borderBottomWidth={1}
                  borderBottomColor={tokens.border}
                  hoverStyle={{ backgroundColor: tokens.bgHover }}
                  {...rowProps}
                >
                  {expandable ? (
                    <XStack width={CARET_W} minWidth={CARET_W} flexShrink={0}>
                      <Text fontSize={10} color={tokens.textTertiary} aria-hidden>
                        {isExpanded ? "▼" : "▶"}
                      </Text>
                    </XStack>
                  ) : null}
                  {cells}
                </XStack>
                {isExpanded ? (
                  <YStack
                    paddingVertical={12}
                    paddingHorizontal={16}
                    paddingLeft={CARET_W + 12}
                    gap={8}
                    backgroundColor={tokens.bgInner}
                    borderBottomWidth={1}
                    borderBottomColor={tokens.border}
                  >
                    {renderExpanded?.(row)}
                  </YStack>
                ) : null}
              </YStack>
            )
          })}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
