/**
 * Runn Renderer — Projects domain.
 *
 * Handles: runn-list-projects, runn-get-project, runn-create-project,
 * runn-update-project. Composes only global primitives + helpers from
 * `./shared`. No local component definitions.
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
  PillList,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  diffFields,
  formatDate,
  ListFooter,
  RUNN_BRAND,
  type RunnProject,
  RunnToolShell,
  unwrap,
  unwrapList,
  useRunnColors,
  useScrollStyle,
} from "./shared"

const PRICING_LABELS: Record<string, string> = {
  fp: "Fixed price",
  tm: "Time & materials",
  nb: "Non-billable",
}

function projectTile(p: RunnProject, size = 22): React.ReactNode {
  return (
    <IconTile accent={RUNN_BRAND.blue} label={(p.name?.[0] ?? "#").toUpperCase()} size={size} />
  )
}

function projectStatusChips(p: RunnProject, text3: string): React.ReactNode {
  const chips: React.ReactNode[] = []
  if (p.isArchived) {
    chips.push(<IconChip key="arch" accent={text3} text="archived" />)
  } else if (p.isConfirmed === false) {
    chips.push(<IconChip key="tent" accent={colors.amber} text="tentative" />)
  } else if (p.isConfirmed) {
    chips.push(<IconChip key="conf" accent={colors.green} text="confirmed" />)
  }
  if (p.isTemplate) chips.push(<IconChip key="tpl" accent={RUNN_BRAND.purple} text="template" />)
  if (chips.length === 0) return null
  return (
    <XStack gap={4} alignItems="center">
      {chips}
    </XStack>
  )
}

function projectDetailRows(p: RunnProject): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  if (p.clientId != null) rows.push({ key: "client", value: `#${p.clientId}` })
  if (p.teamId != null) rows.push({ key: "team", value: `#${p.teamId}` })
  if (p.pricingModel)
    rows.push({ key: "pricing", value: PRICING_LABELS[p.pricingModel] ?? p.pricingModel })
  if (p.rateType) rows.push({ key: "rate type", value: p.rateType })
  if (p.budget != null) rows.push({ key: "budget", value: String(p.budget) })
  if (p.expensesBudget != null) rows.push({ key: "expenses", value: String(p.expensesBudget) })
  if (p.createdAt) rows.push({ key: "created", value: formatDate(p.createdAt) })
  if (p.updatedAt) rows.push({ key: "updated", value: formatDate(p.updatedAt) })
  return rows
}

function tagPills(tags: RunnProject["tags"], text2: string): React.ReactNode {
  if (!tags || tags.length === 0) return null
  return (
    <YStack gap={3}>
      <Text color={text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
        tags
      </Text>
      <PillList
        items={tags.map((t) => <IconChip key={t.id} accent={RUNN_BRAND.purple} text={t.name} />)}
      />
    </YStack>
  )
}

export function ListProjectsRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnProject>(parsed)
  const scrollStyle = useScrollStyle(320)
  const description =
    input?.clientId != null ? `Projects (client #${String(input.clientId)})` : undefined

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
            <Empty message="No projects" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((p) => (
                  <EntityRow
                    key={p.id}
                    leading={projectTile(p)}
                    title={p.name ?? `Project #${p.id}`}
                    subtitle={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        #{p.id}
                        {p.clientId != null ? ` · client #${p.clientId}` : ""}
                      </Text>
                    }
                    badges={projectStatusChips(p, c.text3)}
                    meta={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {formatDate(p.updatedAt)}
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

export function GetProjectRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const project = unwrap<RunnProject>(parsed, "project", "id")

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && project && (
        <ResourceCard
          leading={projectTile(project, 36)}
          title={project.name ?? `Project #${project.id}`}
          subtitle={`#${project.id}`}
          meta={projectStatusChips(project, c.text3)}
        >
          <KeyValueGrid rows={projectDetailRows(project)} />
          {tagPills(project.tags, c.text2)}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}

export function CreateProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const project = unwrap<RunnProject>(parsed, "project", "id")
  const title = project?.name ?? (typeof input?.name === "string" ? input.name : "New project")

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            project ? (
              projectTile(project, 28)
            ) : (
              <IconTile accent={RUNN_BRAND.blue} label="#" size={28} />
            )
          }
          title={title}
          subtitle={project ? `#${project.id}` : undefined}
          verb="created"
          meta={project ? projectStatusChips(project, c.text3) : undefined}
        >
          {project && <KeyValueGrid rows={projectDetailRows(project)} />}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}

const UPDATE_DIFF_KEYS = [
  "name",
  "clientId",
  "isConfirmed",
  "teamId",
  "budget",
  "expensesBudget",
  "pricingModel",
  "rateType",
  "rateCardId",
]

export function UpdateProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const project = unwrap<RunnProject>(parsed, "project", "id")
  const diff = diffFields(input, UPDATE_DIFF_KEYS)
  const title = project?.name ?? "Project updated"

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            project ? (
              projectTile(project, 28)
            ) : (
              <IconTile accent={RUNN_BRAND.blue} label="#" size={28} />
            )
          }
          title={title}
          subtitle={project ? `#${project.id}` : undefined}
          verb="updated"
          meta={project ? projectStatusChips(project, c.text3) : undefined}
        >
          {diff.length > 0 && (
            <YStack gap={3}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                changes
              </Text>
              <KeyValueGrid rows={diff} />
            </YStack>
          )}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}
