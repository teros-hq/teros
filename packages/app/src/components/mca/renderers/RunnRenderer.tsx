/**
 * Runn MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 21/21 tools covered (20 tools + health). `FallbackRenderer` is a dev-only
 * warning signalling a missing entry in the RENDERERS map — in production it
 * should never render.
 */

import type React from "react"
import { Text, YStack } from "tamagui"

import { Badge, FallbackBody, colors as globalColors, ToolCallCard } from "../primitives"
import type { ToolCallRendererProps } from "../types"
import { withPermissionSupport } from "../withPermissionSupport"
import { CreateActualRenderer, ListActualsRenderer } from "./runn/ActualsRenderer"
import {
  CreateAssignmentRenderer,
  DeleteAssignmentRenderer,
  ListAssignmentsRenderer,
} from "./runn/AssignmentsRenderer"
import { HealthCheckRenderer } from "./runn/HealthCheckRenderer"
import {
  CreatePersonRenderer,
  CreatePlaceholderRenderer,
  GetPersonRenderer,
  ListPeopleRenderer,
  ListPlaceholdersRenderer,
} from "./runn/PeopleRenderer"
import {
  CreateProjectRenderer,
  GetProjectRenderer,
  ListProjectsRenderer,
  UpdateProjectRenderer,
} from "./runn/ProjectsRenderer"
import {
  CreateClientRenderer,
  ListClientsRenderer,
  ListRolesRenderer,
  ListSkillsRenderer,
  ListTeamsRenderer,
  ProjectTotalsRenderer,
} from "./runn/ReferenceRenderer"
import { getShortToolName, getToolLabel, RUNN_ICON, toolStatusForPrimitive } from "./runn/shared"

// ============================================================================
// Registry — 21/21 coverage
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Health (SDK contract — shipped in every MCA)
  "-health-check": HealthCheckRenderer,
  // Projects
  "runn-list-projects": ListProjectsRenderer,
  "runn-get-project": GetProjectRenderer,
  "runn-create-project": CreateProjectRenderer,
  "runn-update-project": UpdateProjectRenderer,
  // People & placeholders
  "runn-list-people": ListPeopleRenderer,
  "runn-get-person": GetPersonRenderer,
  "runn-create-person": CreatePersonRenderer,
  "runn-list-placeholders": ListPlaceholdersRenderer,
  "runn-create-placeholder": CreatePlaceholderRenderer,
  // Assignments
  "runn-list-assignments": ListAssignmentsRenderer,
  "runn-create-assignment": CreateAssignmentRenderer,
  "runn-delete-assignment": DeleteAssignmentRenderer,
  // Actuals (timesheets)
  "runn-list-actuals": ListActualsRenderer,
  "runn-create-actual": CreateActualRenderer,
  // Clients
  "runn-list-clients": ListClientsRenderer,
  "runn-create-client": CreateClientRenderer,
  // Reference data & reports
  "runn-list-roles": ListRolesRenderer,
  "runn-list-teams": ListTeamsRenderer,
  "runn-list-skills": ListSkillsRenderer,
  "runn-project-totals": ProjectTotalsRenderer,
}

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName)

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === "completed" ? (
    <Badge text="done" variant="success" />
  ) : status === "failed" ? (
    <Badge text="failed" variant="error" />
  ) : null

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={RUNN_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in RunnRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  )
}

// ============================================================================
// Entry point
// ============================================================================

function RunnRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName)
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer
  return <Renderer {...props} />
}

export const RunnToolCallRenderer = withPermissionSupport(RunnRendererBase)
export default RunnToolCallRenderer
