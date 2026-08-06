/**
 * Runn Renderer — reference data + reports.
 *
 * Handles: runn-list-clients, runn-create-client, runn-list-roles,
 * runn-list-teams, runn-list-skills, runn-project-totals. Composes only
 * global primitives.
 */

import type React from "react"
import { Linking, ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  colors,
  Empty,
  EntityRow,
  ErrorBlock,
  ExternalLink,
  IconChip,
  IconTile,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  fmtMinutes,
  ListFooter,
  RUNN_BRAND,
  type RunnClient,
  type RunnProjectTotals,
  type RunnRole,
  type RunnSkill,
  type RunnTeam,
  RunnToolShell,
  unwrap,
  unwrapList,
  useRunnColors,
  useScrollStyle,
} from "./shared"

function refTile(name: string | undefined | null, accent: string, size = 22): React.ReactNode {
  return <IconTile accent={accent} label={(name?.[0] ?? "#").toUpperCase()} size={size} />
}

function idSubtitle(id: number, text3: string, extra?: string): React.ReactNode {
  return (
    <Text color={text3} fontSize={9} fontFamily="$mono">
      #{id}
      {extra ? ` · ${extra}` : ""}
    </Text>
  )
}

// ── Clients ────────────────────────────────────────────────────────────────

export function ListClientsRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnClient>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No clients" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((item) => (
                  <EntityRow
                    key={item.id}
                    leading={refTile(item.name, RUNN_BRAND.navy)}
                    title={item.name ?? `Client #${item.id}`}
                    subtitle={idSubtitle(item.id, c.text3, item.website ?? undefined)}
                    badges={
                      item.isArchived ? <IconChip accent={c.text3} text="archived" /> : null
                    }
                    onPress={item.website ? () => Linking.openURL(item.website as string) : undefined}
                    trailing={
                      item.website ? <ExternalLink size={12} color={c.text3} /> : undefined
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

export function CreateClientRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const client = unwrap<RunnClient>(parsed, "client", "id")
  const name = client?.name ?? (typeof input?.name === "string" ? input.name : "New client")

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={refTile(name, RUNN_BRAND.navy, 28)}
          title={name}
          subtitle={
            client ? `#${client.id}${client.website ? ` · ${client.website}` : ""}` : undefined
          }
          verb="created"
        />
      )}
    </RunnToolShell>
  )
}

// ── Roles ──────────────────────────────────────────────────────────────────

function roleChips(r: RunnRole, text3: string): React.ReactNode {
  const chips: React.ReactNode[] = []
  if (r.standardRate != null)
    chips.push(<IconChip key="rate" accent={colors.green} text={`rate ${r.standardRate}`} />)
  if (r.defaultHourCost != null)
    chips.push(<IconChip key="cost" accent={text3} text={`cost ${r.defaultHourCost}`} />)
  if (r.isArchived) chips.push(<IconChip key="arch" accent={text3} text="archived" />)
  if (chips.length === 0) return null
  return (
    <XStack gap={4} alignItems="center">
      {chips}
    </XStack>
  )
}

export function ListRolesRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnRole>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No roles" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((r) => (
                  <EntityRow
                    key={r.id}
                    leading={refTile(r.name ?? undefined, RUNN_BRAND.purple)}
                    title={r.name ?? `Role #${r.id}`}
                    subtitle={idSubtitle(r.id, c.text3)}
                    badges={roleChips(r, c.text3)}
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

// ── Teams ──────────────────────────────────────────────────────────────────

export function ListTeamsRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnTeam>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No teams" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((t) => (
                  <EntityRow
                    key={t.id}
                    leading={refTile(t.name, RUNN_BRAND.blue)}
                    title={t.name ?? `Team #${t.id}`}
                    subtitle={idSubtitle(t.id, c.text3)}
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

// ── Skills ─────────────────────────────────────────────────────────────────

export function ListSkillsRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnSkill>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No skills" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((s) => (
                  <EntityRow
                    key={s.id}
                    leading={refTile(s.name, RUNN_BRAND.purple)}
                    title={s.name ?? `Skill #${s.id}`}
                    subtitle={idSubtitle(s.id, c.text3)}
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

// ── Project totals (report) ─────────────────────────────────────────────────

export function ProjectTotalsRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnProjectTotals>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No project totals" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((p) => (
                  <EntityRow
                    key={p.id}
                    leading={<IconTile accent={RUNN_BRAND.blue} label="Σ" size={22} />}
                    title={`Project #${p.id}`}
                    subtitle={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {fmtMinutes(p.billableMinutes)} billable ·{" "}
                        {fmtMinutes(p.nonBillableMinutes)} non-bill
                      </Text>
                    }
                    meta={
                      <Text color={c.text2} fontSize={9} fontFamily="$mono">
                        Σ {fmtMinutes(p.totalMinutes)}
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
