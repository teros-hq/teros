/**
 * Runn Renderer — Actuals (timesheets) domain.
 *
 * Handles: runn-list-actuals, runn-create-actual. Logged real hours per day.
 * Composes only global primitives.
 */

import type React from "react"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  colors,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  fmtMinutes,
  ListFooter,
  RUNN_BRAND,
  type RunnActual,
  RunnToolShell,
  unwrap,
  unwrapList,
  useRunnColors,
  useScrollStyle,
} from "./shared"

function minuteChips(
  a: {
    billableMinutes?: number
    nonbillableMinutes?: number
  },
  text3: string,
): React.ReactNode {
  const chips: React.ReactNode[] = []
  if (a.billableMinutes)
    chips.push(
      <IconChip key="b" accent={colors.green} text={`${fmtMinutes(a.billableMinutes)} billable`} />,
    )
  if (a.nonbillableMinutes)
    chips.push(
      <IconChip
        key="n"
        accent={text3}
        text={`${fmtMinutes(a.nonbillableMinutes)} non-bill`}
      />,
    )
  if (chips.length === 0) return null
  return (
    <XStack gap={4} alignItems="center">
      {chips}
    </XStack>
  )
}

function actualRows(a: RunnActual): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  if (a.date) rows.push({ key: "date", value: a.date })
  if (a.personId != null) rows.push({ key: "person", value: `#${a.personId}` })
  if (a.projectId != null) rows.push({ key: "project", value: `#${a.projectId}` })
  if (a.roleId != null) rows.push({ key: "role", value: `#${a.roleId}` })
  if (a.billableMinutes != null)
    rows.push({ key: "billable", value: fmtMinutes(a.billableMinutes) })
  if (a.nonbillableMinutes != null)
    rows.push({ key: "non-billable", value: fmtMinutes(a.nonbillableMinutes) })
  if (a.billableNote) rows.push({ key: "billable note", value: a.billableNote })
  if (a.nonbillableNote) rows.push({ key: "non-bill note", value: a.nonbillableNote })
  return rows
}

export function ListActualsRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnActual>(parsed)
  const scrollStyle = useScrollStyle(320)
  const scope =
    input?.personId != null
      ? `person #${String(input.personId)}`
      : input?.projectId != null
        ? `project #${String(input.projectId)}`
        : undefined
  const description = scope ? `Timesheets (${scope})` : undefined

  return (
    <RunnToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No timesheet entries" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((a) => (
                  <EntityRow
                    key={a.id}
                    leading={<IconTile accent={RUNN_BRAND.blue} label="⏱" size={22} />}
                    title={`Person #${a.personId ?? "?"} · Project #${a.projectId ?? "?"}`}
                    subtitle={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {a.date ?? "—"} · role #{a.roleId ?? "?"}
                      </Text>
                    }
                    badges={minuteChips(a, c.text3)}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          <ListFooter total={total} nextCursor={nextCursor} />
        </>
      )}
    </RunnToolShell>
  )
}

export function CreateActualRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const actual = unwrap<RunnActual>(parsed, "actual", "id")
  const date = actual?.date ?? (typeof input?.date === "string" ? input.date : undefined)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={<IconTile accent={RUNN_BRAND.blue} label="⏱" size={28} />}
          title={date ? `Time logged for ${date}` : "Time logged"}
          subtitle={actual ? `#${actual.id}` : undefined}
          verb="created"
          meta={actual ? minuteChips(actual, c.text3) : undefined}
        >
          {actual && <KeyValueGrid rows={actualRows(actual)} />}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}
