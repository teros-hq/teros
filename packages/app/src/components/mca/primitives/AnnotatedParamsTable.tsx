/**
 * Annotated Params Table — the parameter readout for `pending_permission`.
 *
 * Unlike `ParamsTable` (deliberately flat, correct for completed calls), this
 * table is built for a decision: params are ranked required-first, each row
 * carries the schema property's own description, containers expand in place, and
 * a param the tool never declared is flagged. See
 * docs/specs/mca/permission-approval-detail.md.
 *
 * Look: the OS prototype's `.kvl` — a 110px/1fr key/value list, keys mono 11
 * text3, values sans 13 text2 — plus the "View JSON" disclosure for the raw
 * payload.
 */

import { useTranslation } from "react-i18next"
import { useState } from "react"
import { Platform, Pressable } from "react-native"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { JsonToggle } from "./JsonToggle"
import {
  type BoundedValue,
  boundValue,
  PARAM_CAPS,
  type RankedParam,
  rankParams,
  type ToolParameters,
} from "./param-relevance"
import { useColors } from "./useColors"

/** `.kvl` key column — `grid-template-columns: 110px 1fr`. */
export const KV_KEY_WIDTH = 110

export interface AnnotatedParamsTableProps {
  input?: Record<string, unknown>
  schema?: ToolParameters
  /** Rows shown before the "show all" toggle. Defaults to PARAM_CAPS.compactRows. */
  maxRows?: number
}

export function AnnotatedParamsTable({
  input,
  schema,
  maxRows = PARAM_CAPS.compactRows,
}: AnnotatedParamsTableProps) {
  const c = useColors()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [toggleHover, setToggleHover] = useState(false)

  const ranked = rankParams(input, schema)

  if (ranked.length === 0) {
    return (
      <YStack testID="permission-params">
        <T step="12" tone="text3">
          {t("mca.permissionDetail.noParams")}
        </T>
      </YStack>
    )
  }

  const overflows = ranked.length > maxRows
  const visible = expanded || !overflows ? ranked : ranked.slice(0, maxRows)
  const hiddenUndeclared = expanded ? 0 : hiddenUndeclaredCount(ranked, maxRows)

  return (
    <YStack gap={8} testID="permission-params">
      <YStack gap={6}>
        {visible.map((param) => (
          <ParamRow key={param.key} param={param} />
        ))}
      </YStack>

      {overflows ? (
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          accessibilityRole="button"
          testID="permission-params-toggle"
          {...(Platform.OS === "web"
            ? { onHoverIn: () => setToggleHover(true), onHoverOut: () => setToggleHover(false) }
            : {})}
          style={[
            { alignSelf: "flex-start" },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <T
            step="12"
            color={toggleHover ? c.accent : c.text3}
            testID="permission-params-toggle-label"
          >
            {expanded
              ? t("mca.permissionDetail.hideParams")
              : t("mca.permissionDetail.showAllParams", { count: ranked.length })}
            {hiddenUndeclared > 0
              ? ` — ${t("mca.permissionDetail.hiddenUndeclared", { count: hiddenUndeclared })}`
              : ""}
          </T>
        </Pressable>
      ) : null}

      <JsonToggle value={input} testID="permission-params-json-toggle" />
    </YStack>
  )
}

function isContainer(value: unknown): boolean {
  return typeof value === "object" && value !== null
}

/**
 * How many of the rows the cap is hiding were never declared by the tool.
 *
 * `rankParams` sorts undeclared params last, so on a call with enough declared
 * params the collapsed view hides exactly the rows a reviewer most needs: a
 * parameter the tool never declared is the highest-signal anomaly on an approval
 * card. The cap still applies — an approval card that grows without bound is its
 * own problem — but the toggle has to say what is behind it rather than describe
 * the hidden rows as a plain count.
 */
function hiddenUndeclaredCount(ranked: RankedParam[], maxRows: number): number {
  if (ranked.length <= maxRows) return 0
  return ranked.slice(maxRows).filter((param) => param.undeclared).length
}

/** @internal exported for test-only direct rendering — see AnnotatedParamsTable.render.test.tsx. */
export interface ParamRowProps {
  param: RankedParam
  depth?: number
  /** True for a container's expanded children — the schema never described them,
   * so `undeclared` there means "never checked", not "verified declared". This is
   * the only thing that suppresses the "not in schema" tag on a synthetic row —
   * `RankedParam.undeclared` is hardcoded `false` at the construction site above
   * because a child's real declared status is unknowable, not because it was
   * checked and found fine. */
  synthetic?: boolean
}

/** @internal exported for test-only direct rendering — see AnnotatedParamsTable.render.test.tsx. */
export function ParamRow({ param, depth = 0, synthetic = false }: ParamRowProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const bounded = boundValue(param.value, depth)
  const expandable = bounded.children.length > 0

  return (
    <XStack gap={12} alignItems="flex-start">
      {/* `.kvl dt` — mono 11, text3. Nested rows narrow the key column so the
          value column keeps room. */}
      <T
        step="code"
        tone="text3"
        style={{
          width: depth > 0 ? 80 : KV_KEY_WIDTH,
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 18,
        }}
      >
        {param.key}
      </T>

      {/* Everything this row discloses belongs in the value column, including the
          expanded children: the toggle lives here, so the content it reveals has
          to live here too. Emitting the children as a sibling of this XStack put
          them under the key label instead — outside the disclosure that owns
          them, and (in the grouped panel) sprawling under the deny/allow
          buttons. */}
      <YStack flex={1} minWidth={0} gap={2}>
        <ParamValueCell
          bounded={bounded}
          expandable={expandable}
          onToggle={() => setOpen((prev) => !prev)}
        />

        {param.description ? (
          <T step="12" tone="text3">
            {param.description}
          </T>
        ) : null}

        {param.undeclared && !synthetic ? (
          <T step="12" tone="text3" style={{ fontStyle: "italic" }}>
            {t("mca.permissionDetail.undeclared")}
          </T>
        ) : null}

        {/* The nesting cap withholds content that NO interaction can reveal, so
            it gets a statement rather than a toggle. Silence here reads as
            "this container is empty", which is the one thing it is not. */}
        {bounded.atDepthLimit && bounded.hiddenCount > 0 ? (
          <T step="12" tone="text3" style={{ fontStyle: "italic" }} testID="param-nesting-limit">
            {t("mca.permissionDetail.nestingLimit", { count: bounded.hiddenCount })}
          </T>
        ) : null}

        {open && expandable ? <ParamRowChildren depth={depth} bounded={bounded} /> : null}
      </YStack>
    </XStack>
  )
}

/** `.kvl dd` — sans 13, text2. */
const VALUE_STYLE = { fontSize: 13, lineHeight: 18 } as const

function ParamValueCell({
  bounded,
  expandable,
  onToggle,
}: {
  bounded: BoundedValue
  expandable: boolean
  onToggle: () => void
}) {
  const c = useColors()
  const { t } = useTranslation()
  const [showingFull, setShowingFull] = useState(false)

  if (expandable) {
    return (
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        style={
          Platform.OS === "web"
            ? ({ cursor: "pointer", alignSelf: "flex-start" } as any)
            : { alignSelf: "flex-start" }
        }
      >
        <T step="code" tone="accent" style={{ fontSize: 12, lineHeight: 18 }}>
          {bounded.text}
        </T>
      </Pressable>
    )
  }

  // "show more" is only honest for a truncated SCALAR, where the rest of the
  // string exists and the row can grow to hold it. `fullText` is that rest: the
  // hint used to be plain text over a value whose tail had been discarded at
  // bounding time, so tapping it did nothing and a reviewer approving a large
  // `content` param saw 240 characters and an invitation that led nowhere. A
  // depth-capped container is also `truncated` but has no scalar tail; it gets
  // the nesting-limit statement in ParamRow instead.
  const full = bounded.atDepthLimit ? undefined : bounded.fullText

  if (!full) {
    return (
      <T step="sm" tone="text2" style={VALUE_STYLE} selectable>
        {bounded.text}
      </T>
    )
  }

  return (
    <Pressable
      onPress={() => setShowingFull((prev) => !prev)}
      accessibilityRole="button"
      testID="param-value-more"
      style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
    >
      <T step="sm" tone="text2" style={VALUE_STYLE}>
        {showingFull ? full : bounded.text}
        <T step="sm" color={c.accent} style={VALUE_STYLE}>
          {showingFull
            ? ` ${t("mca.permissionDetail.showLess")}`
            : ` … ${t("mca.permissionDetail.showMore")}`}
        </T>
      </T>
    </Pressable>
  )
}

/**
 * The expanded children of one container, as a contained disclosure region.
 *
 * The left rule is what encodes nesting depth now: it is drawn once per level and
 * sits inside the parent's value column, so depth is read from the stack of rules
 * rather than from an absolute pixel indent that had drifted out of step with the
 * key column.
 */
function ParamRowChildren({ depth, bounded }: { depth: number; bounded: BoundedValue }) {
  const c = useColors()
  const { t } = useTranslation()

  return (
    <YStack
      gap={4}
      marginTop={4}
      paddingLeft={10}
      borderLeftWidth={1}
      borderLeftColor={c.borderStrong}
      testID="param-children"
    >
      {bounded.children.map((child) => (
        <ParamRow
          key={child.key}
          depth={depth + 1}
          synthetic
          param={{
            key: child.key,
            value: child.value,
            required: false,
            // A child's declared status is UNKNOWABLE: ToolParameters describes only
            // top-level properties. `synthetic` is what suppresses the "not in schema"
            // tag for these rows — do not "simplify" it away, and do not assert
            // undeclared:false here, which would claim the child was checked and found
            // declared.
            undeclared: false,
            container: isContainer(child.value),
          }}
        />
      ))}

      {bounded.hiddenCount > 0 ? (
        <T step="12" tone="text3" style={{ fontStyle: "italic" }}>
          {t("mca.permissionDetail.moreItems", { count: bounded.hiddenCount })}
        </T>
      ) : null}
    </YStack>
  )
}
