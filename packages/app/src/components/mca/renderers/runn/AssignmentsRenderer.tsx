/**
 * Runn Renderer — Assignments domain.
 *
 * Handles: runn-list-assignments, runn-create-assignment,
 * runn-delete-assignment. Allocation of a person/placeholder to a project at
 * a role over a date range. Composes only global primitives.
 */

import type React from "react"
import { ScrollView } from "react-native"
import { Text, YStack } from "tamagui"
import {
  colors,
  DualEntity,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  parseOutput,
  ResourceCard,
  SuccessBlock,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  fmtMinutes,
  formatDate,
  ListFooter,
  RUNN_BRAND,
  type RunnAssignment,
  RunnToolShell,
  unwrap,
  unwrapList,
  useRunnColors,
  useScrollStyle,
} from "./shared"

function partyLabel(a: { personId?: number; isPlaceholder?: boolean }): string {
  return `${a.isPlaceholder ? "Placeholder" : "Person"} #${a.personId ?? "?"}`
}

function billableChip(isBillable: boolean | undefined, text3: string): React.ReactNode {
  if (isBillable === false) return <IconChip accent={text3} text="non-billable" />
  if (isBillable) return <IconChip accent={colors.green} text="billable" />
  return null
}

function assignmentBadges(a: RunnAssignment, text3: string): React.ReactNode {
  const chips: React.ReactNode[] = []
  const billable = billableChip(a.isBillable, text3)
  if (billable) chips.push(<YStack key="bill">{billable}</YStack>)
  if (a.isPlaceholder)
    chips.push(<IconChip key="ph" accent={RUNN_BRAND.purple} text="placeholder" />)
  if (chips.length === 0) return null
  return <>{chips}</>
}

export function ListAssignmentsRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnAssignment>(parsed)
  const scrollStyle = useScrollStyle(320)
  const scope =
    input?.personId != null
      ? `person #${String(input.personId)}`
      : input?.projectId != null
        ? `project #${String(input.projectId)}`
        : undefined
  const description = scope ? `Assignments (${scope})` : undefined

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
            <Empty message="No assignments" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((a) => (
                  <EntityRow
                    key={a.id}
                    leading={
                      <IconTile
                        accent={a.isBillable === false ? c.text3 : RUNN_BRAND.blue}
                        label="#"
                        size={22}
                      />
                    }
                    title={`${partyLabel(a)} → Project #${a.projectId ?? "?"}`}
                    subtitle={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        role #{a.roleId ?? "?"} · {fmtMinutes(a.minutesPerDay)}/day
                      </Text>
                    }
                    badges={assignmentBadges(a, c.text3)}
                    meta={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {a.startDate
                          ? `${a.startDate} → ${a.endDate ?? ""}`
                          : formatDate(a.updatedAt)}
                      </Text>
                    }
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

export function CreateAssignmentRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const a = unwrap<RunnAssignment>(parsed, "assignment", "id")

  const personId = a?.personId ?? (typeof input?.personId === "number" ? input.personId : undefined)
  const projectId =
    a?.projectId ?? (typeof input?.projectId === "number" ? input.projectId : undefined)
  const roleId = a?.roleId ?? (typeof input?.roleId === "number" ? input.roleId : undefined)
  const minutesPerDay =
    a?.minutesPerDay ?? (typeof input?.minutesPerDay === "number" ? input.minutesPerDay : undefined)
  const startDate =
    a?.startDate ?? (typeof input?.startDate === "string" ? input.startDate : undefined)
  const endDate = a?.endDate ?? (typeof input?.endDate === "string" ? input.endDate : undefined)
  const isPlaceholder = a?.isPlaceholder ?? false

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <YStack gap={8}>
          <DualEntity
            left={{
              visual: <IconTile accent={RUNN_BRAND.blue} label="P" size={28} />,
              title: partyLabel({ personId, isPlaceholder }),
              subtitle: roleId != null ? `role #${roleId}` : undefined,
            }}
            right={{
              visual: <IconTile accent={RUNN_BRAND.purple} label="#" size={28} />,
              title: `Project #${projectId ?? "?"}`,
              subtitle: minutesPerDay != null ? `${fmtMinutes(minutesPerDay)}/day` : undefined,
            }}
            action="add-member"
            meta={startDate && endDate ? `${startDate} → ${endDate}` : undefined}
          />
          {a?.note ? (
            <Text color={c.text2} fontSize={10}>
              {a.note}
            </Text>
          ) : null}
        </YStack>
      )}
    </RunnToolShell>
  )
}

export function DeleteAssignmentRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<{ success?: boolean; assignmentId?: number }>(output) : null
  const result =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && "success" in parsed
      ? parsed
      : null
  const id = String(input?.assignmentId ?? result?.assignmentId ?? "")

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={<IconTile accent={colors.red} label="×" size={28} />}
          title={`Deleted assignment ${id ? `#${id}` : ""}`.trim()}
          subtitle="Removed from the schedule — cannot be undone."
          verb="deleted"
        >
          {result?.success && (
            <SuccessBlock message={`Assignment ${id ? `#${id}` : ""} deleted.`} />
          )}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}
