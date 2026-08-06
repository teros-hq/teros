/**
 * Runn Renderer — People & Placeholders domain.
 *
 * Handles: runn-list-people, runn-get-person, runn-create-person,
 * runn-list-placeholders, runn-create-placeholder. Composes only global
 * primitives + helpers from `./shared`.
 */

import type React from "react"
import { ScrollView } from "react-native"
import { Text, YStack } from "tamagui"
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
  formatDate,
  ListFooter,
  personName,
  RUNN_BRAND,
  type RunnPerson,
  type RunnPlaceholder,
  RunnToolShell,
  unwrap,
  unwrapList,
  useRunnColors,
  useScrollStyle,
} from "./shared"

function personTile(name: string, size = 22): React.ReactNode {
  return <IconTile accent={RUNN_BRAND.blue} label={(name[0] ?? "#").toUpperCase()} size={size} />
}

function archivedChip(isArchived: boolean | undefined, text3: string): React.ReactNode {
  if (!isArchived) return null
  return <IconChip accent={text3} text="archived" />
}

function personDetailRows(p: RunnPerson): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  if (p.email) rows.push({ key: "email", value: p.email })
  if (p.teamId != null) rows.push({ key: "team", value: `#${p.teamId}` })
  if (p.holidaysGroupId != null) rows.push({ key: "holiday group", value: `#${p.holidaysGroupId}` })
  if (p.createdAt) rows.push({ key: "created", value: formatDate(p.createdAt) })
  if (p.updatedAt) rows.push({ key: "updated", value: formatDate(p.updatedAt) })
  return rows
}

export function ListPeopleRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnPerson>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No people" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((p) => {
                  const name = personName(p)
                  return (
                    <EntityRow
                      key={p.id}
                      leading={personTile(name)}
                      title={name}
                      subtitle={
                        <Text color={c.text3} fontSize={9} fontFamily="$mono">
                          #{p.id}
                          {p.email ? ` · ${p.email}` : ""}
                        </Text>
                      }
                      badges={archivedChip(p.isArchived, c.text3)}
                      meta={
                        <Text color={c.text3} fontSize={9} fontFamily="$mono">
                          {formatDate(p.updatedAt)}
                        </Text>
                      }
                    />
                  )
                })}
              </YStack>
            </ScrollView>
          )}
          <ListFooter total={total} nextCursor={nextCursor} />
        </>
      )}
    </RunnToolShell>
  )
}

export function GetPersonRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const person = unwrap<RunnPerson>(parsed, "person", "id")
  const name = person ? personName(person) : "Person"

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && person && (
        <ResourceCard
          leading={personTile(name, 36)}
          title={name}
          subtitle={`#${person.id}`}
          meta={archivedChip(person.isArchived, c.text3)}
        >
          <KeyValueGrid rows={personDetailRows(person)} />
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}

export function CreatePersonRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const person = unwrap<RunnPerson>(parsed, "person", "id")
  const name = person
    ? personName(person)
    : [input?.firstName, input?.lastName].filter(Boolean).join(" ") || "New person"

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={personTile(name, 28)}
          title={name}
          subtitle={person ? `#${person.id}` : undefined}
          verb="created"
        >
          {person && <KeyValueGrid rows={personDetailRows(person)} />}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}

export function ListPlaceholdersRenderer({
  toolName,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const { items, nextCursor, total } = unwrapList<RunnPlaceholder>(parsed)
  const scrollStyle = useScrollStyle(320)

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {items.length === 0 ? (
            <Empty message="No placeholders" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {items.map((p) => {
                  const name = personName(p, "Placeholder")
                  return (
                    <EntityRow
                      key={p.id}
                      leading={
                        <IconTile
                          accent={RUNN_BRAND.purple}
                          label={(name[0] ?? "#").toUpperCase()}
                          size={22}
                        />
                      }
                      title={name}
                      subtitle={
                        <Text color={c.text3} fontSize={9} fontFamily="$mono">
                          #{p.id}
                        </Text>
                      }
                      badges={archivedChip(p.isArchived, c.text3)}
                      meta={
                        <Text color={c.text3} fontSize={9} fontFamily="$mono">
                          {formatDate(p.updatedAt)}
                        </Text>
                      }
                    />
                  )
                })}
              </YStack>
            </ScrollView>
          )}
          <ListFooter total={total} nextCursor={nextCursor} />
        </>
      )}
    </RunnToolShell>
  )
}

export function CreatePlaceholderRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const placeholder = unwrap<RunnPlaceholder>(parsed, "placeholder", "id")
  const name = placeholder
    ? personName(placeholder, "Placeholder")
    : `Placeholder (role #${String(input?.roleId ?? "?")})`

  return (
    <RunnToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            <IconTile accent={RUNN_BRAND.purple} label={(name[0] ?? "#").toUpperCase()} size={28} />
          }
          title={name}
          subtitle={placeholder ? `#${placeholder.id}` : undefined}
          verb="created"
        />
      )}
    </RunnToolShell>
  )
}
