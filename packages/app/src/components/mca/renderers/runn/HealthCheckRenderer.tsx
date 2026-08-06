/**
 * Runn Renderer — health check (`-health-check`).
 *
 * Renders the `{ status, version?, uptime?, issues? }` shape from
 * `HealthCheckBuilder.build()`. Composes only global primitives.
 */

import { Text, YStack } from "tamagui"
import {
  Badge,
  colors,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
  SuccessBlock,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { RunnToolShell, useRunnColors } from "./shared"

interface HealthIssue {
  code: string
  message: string
  action?: { type?: string; description?: string; url?: string }
}
interface HealthResult {
  status?: "ready" | "degraded" | "not_ready"
  version?: string
  uptime?: number
  issues?: HealthIssue[]
}

const STATUS_ACCENT: Record<string, string> = {
  ready: colors.green,
  degraded: colors.amber,
  not_ready: colors.red,
}

export function HealthCheckRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const c = useRunnColors()
  const parsed = output ? parseOutput<unknown>(output) : null
  const result =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && "status" in (parsed as object)
      ? (parsed as HealthResult)
      : null

  const healthStatus = result?.status ?? "ready"
  const issues = result?.issues ?? []
  const healthy = healthStatus === "ready" && issues.length === 0
  const accent = STATUS_ACCENT[healthStatus] ?? colors.green

  const rows: KeyValueRow[] = []
  if (result?.version) rows.push({ key: "version", value: `v${result.version}` })
  if (typeof result?.uptime === "number") rows.push({ key: "uptime", value: `${result.uptime}s` })

  // Surface the health verdict in the header badge so it is visible without
  // expanding the card (and assertable in render tests).
  const healthBadge =
    status !== "completed" ? undefined : healthy ? (
      <Badge text="healthy" variant="success" />
    ) : (
      <Badge text="degraded" variant={healthStatus === "not_ready" ? "error" : "warning"} />
    )

  return (
    <RunnToolShell
      toolName={toolName}
      status={status}
      description="Health check"
      defaultExpanded={false}
      badge={healthBadge}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={<IconTile accent={accent} label={healthy ? "✓" : "!"} size={28} />}
          title={healthy ? "Runn connection healthy" : `Status: ${healthStatus}`}
          subtitle={result?.version ? `Runn MCA v${result.version}` : undefined}
          meta={<IconChip accent={accent} text={healthStatus} />}
        >
          {rows.length > 0 && <KeyValueGrid rows={rows} />}
          {healthy && <SuccessBlock message="API token valid and Runn reachable." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              {issues.map((iss, i) => (
                <YStack
                  key={`${iss.code}-${i}`}
                  gap={4}
                  padding={8}
                  borderRadius={5}
                  backgroundColor={`${accent}12`}
                  borderWidth={1}
                  borderColor={`${accent}33`}
                >
                  <IconChip accent={accent} text={iss.code} />
                  <Text color={c.text} fontSize={10}>
                    {iss.message}
                  </Text>
                  {iss.action?.description && (
                    <Text color={c.text2} fontSize={9}>
                      → {iss.action.description}
                      {iss.action.url ? ` (${iss.action.url})` : ""}
                    </Text>
                  )}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </RunnToolShell>
  )
}
