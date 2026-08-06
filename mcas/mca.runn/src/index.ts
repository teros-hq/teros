#!/usr/bin/env bun

/**
 * Runn MCA v1.0.0
 *
 * Runn resource management (https://runn.io) over its REST API v1, using
 * McaServer with HTTP transport. The API key is fetched on-demand from the
 * backend on every request.
 *
 * Features:
 * - Projects (list, get, create, update)
 * - People & placeholders (list, get, create)
 * - Assignments (list, create, delete) — allocate capacity to projects
 * - Actuals / timesheets (list, create)
 * - Clients (list, create)
 * - Reference data: roles, teams, skills
 * - Reports: project minute totals
 */

import { HealthCheckBuilder, McaServer } from "@teros/mca-sdk"
import { validateCredentials } from "./lib"
import {
  createActual,
  createAssignment,
  createClient,
  createPerson,
  createPlaceholder,
  createProject,
  deleteAssignment,
  getPerson,
  getProject,
  listActuals,
  listAssignments,
  listClients,
  listPeople,
  listPlaceholders,
  listProjects,
  listRoles,
  listSkills,
  listTeams,
  projectTotals,
  updateProject,
} from "./tools"

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: "mca.runn",
  name: "Runn",
  version: "1.0.0",
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool("-health-check", {
  description: "Internal health check tool. Verifies the Runn API key and connectivity.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion("1.0.0")
      .setUptime(Math.floor(process.uptime()))

    try {
      const userSecrets = await context.getUserSecrets()

      if (!userSecrets.API_KEY) {
        builder.addIssue("USER_CONFIG_MISSING", "Runn API token not configured", {
          type: "user_action",
          description: "Generate an API token in Runn (Settings > API) and add it in app settings.",
        })
      } else {
        try {
          await validateCredentials(context)
        } catch (apiError: any) {
          const msg = String(apiError?.message ?? "")
          if (/401|403|AUTH_INVALID|PERMISSION_DENIED|unauthori[sz]ed/i.test(msg)) {
            builder.addIssue("AUTH_INVALID", "Runn API token is invalid", {
              type: "user_action",
              description: "The configured Runn API token is invalid or expired. Please update it.",
            })
          } else {
            builder.addIssue("DEPENDENCY_UNAVAILABLE", `Runn API error: ${apiError.message}`, {
              type: "auto_retry",
              description: "Runn API temporarily unavailable.",
            })
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        "SYSTEM_CONFIG_MISSING",
        error instanceof Error ? error.message : "Failed to get secrets",
        {
          type: "admin_action",
          description: "Ensure callbackUrl is provided and the backend is reachable.",
        },
      )
    }

    return builder.build()
  },
})

// =============================================================================
// REGISTER TOOLS: PROJECTS
// =============================================================================

server.tool("runn-list-projects", listProjects)
server.tool("runn-get-project", getProject)
server.tool("runn-create-project", createProject)
server.tool("runn-update-project", updateProject)

// =============================================================================
// REGISTER TOOLS: PEOPLE & PLACEHOLDERS
// =============================================================================

server.tool("runn-list-people", listPeople)
server.tool("runn-get-person", getPerson)
server.tool("runn-create-person", createPerson)
server.tool("runn-list-placeholders", listPlaceholders)
server.tool("runn-create-placeholder", createPlaceholder)

// =============================================================================
// REGISTER TOOLS: ASSIGNMENTS
// =============================================================================

server.tool("runn-list-assignments", listAssignments)
server.tool("runn-create-assignment", createAssignment)
server.tool("runn-delete-assignment", deleteAssignment)

// =============================================================================
// REGISTER TOOLS: ACTUALS (TIMESHEETS)
// =============================================================================

server.tool("runn-list-actuals", listActuals)
server.tool("runn-create-actual", createActual)

// =============================================================================
// REGISTER TOOLS: CLIENTS
// =============================================================================

server.tool("runn-list-clients", listClients)
server.tool("runn-create-client", createClient)

// =============================================================================
// REGISTER TOOLS: REFERENCE DATA & REPORTS
// =============================================================================

server.tool("runn-list-roles", listRoles)
server.tool("runn-list-teams", listTeams)
server.tool("runn-list-skills", listSkills)
server.tool("runn-project-totals", projectTotals)

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error("🟣 Runn MCA server running")
  })
  .catch((error) => {
    console.error("Failed to start Runn MCA:", error)
    process.exit(1)
  })
