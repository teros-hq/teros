/**
 * NavBar realtime events (TER-304)
 *
 * Schemas for the WS events emitted by the backend when an entity that the
 * NavBar renders mutates. The frontend hook `useNavbarRealtimeSync` consumes
 * these to keep agents/workspaces/projects/apps/conversations in sync without
 * polling or page reloads.
 *
 * Naming: `domain.verb-past` (matches the CLAUDE.md `domain.verb` convention
 * used for WS request actions, in past tense for the broadcast counterpart).
 *
 * Scope (decided in TER-304 plan):
 *   - agent.* : workspace fan-out when the agent has workspaceId, user fan-out
 *               for global agents.
 *   - workspace.created : user fan-out (creator is the only member).
 *   - workspace.updated : workspace fan-out.
 *   - workspace.archived : user fan-out per captured-before-archive member list.
 *   - project.* : workspace fan-out (projects are workspace-scoped).
 *   - app.* : workspace fan-out (ownerId == privateWorkspaceId today).
 *
 * Payloads here describe the broadcast shape only. They are intentionally
 * permissive (`.passthrough()`) because the optimistic frontend store accepts
 * additional fields the backend may add later without rebuilding the client.
 */

import { z } from 'zod';

// ----------------------------------------------------------------------------
// Reusable summaries — kept narrow on purpose to match the navbar projection.
// Do NOT extend with computed/UI-only fields; the frontend composes those.
// ----------------------------------------------------------------------------

const AgentBroadcastSummarySchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    fullName: z.string().optional(),
    role: z.string().optional(),
    intro: z.string().optional(),
    avatarUrl: z.string().optional(),
    coreId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .passthrough();

const WorkspaceBroadcastSummarySchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    volumeId: z.string().optional(),
    role: z.string().optional(),
    status: z.string().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    appearance: z
      .object({ color: z.string().optional(), icon: z.string().optional() })
      .optional(),
    type: z.enum(['private', 'shared']).optional(),
    context: z.string().optional(),
  })
  .passthrough();

const ProjectBroadcastSummarySchema = z
  .object({
    projectId: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const AppBroadcastSummarySchema = z
  .object({
    appId: z.string(),
    mcaId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    category: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

// ----------------------------------------------------------------------------
// Agent events
// ----------------------------------------------------------------------------

export const AgentCreatedEventSchema = z.object({
  type: z.literal('agent.created'),
  agent: AgentBroadcastSummarySchema,
});
export type AgentCreatedEvent = z.infer<typeof AgentCreatedEventSchema>;

export const AgentUpdatedEventSchema = z.object({
  type: z.literal('agent.updated'),
  agent: AgentBroadcastSummarySchema,
});
export type AgentUpdatedEvent = z.infer<typeof AgentUpdatedEventSchema>;

export const AgentDeletedEventSchema = z.object({
  type: z.literal('agent.deleted'),
  agentId: z.string(),
  workspaceId: z.string().optional(),
});
export type AgentDeletedEvent = z.infer<typeof AgentDeletedEventSchema>;

// ----------------------------------------------------------------------------
// Workspace events
// ----------------------------------------------------------------------------

export const WorkspaceCreatedNavbarEventSchema = z.object({
  type: z.literal('workspace.created'),
  workspace: WorkspaceBroadcastSummarySchema,
});
export type WorkspaceCreatedNavbarEvent = z.infer<typeof WorkspaceCreatedNavbarEventSchema>;

export const WorkspaceUpdatedNavbarEventSchema = z.object({
  type: z.literal('workspace.updated'),
  workspace: WorkspaceBroadcastSummarySchema,
});
export type WorkspaceUpdatedNavbarEvent = z.infer<typeof WorkspaceUpdatedNavbarEventSchema>;

export const WorkspaceArchivedNavbarEventSchema = z.object({
  type: z.literal('workspace.archived'),
  workspaceId: z.string(),
});
export type WorkspaceArchivedNavbarEvent = z.infer<typeof WorkspaceArchivedNavbarEventSchema>;

// ----------------------------------------------------------------------------
// Project events
// ----------------------------------------------------------------------------

export const ProjectCreatedEventSchema = z.object({
  type: z.literal('project.created'),
  project: ProjectBroadcastSummarySchema,
  // The board document created alongside is opaque to the navbar — accept any.
  board: z.unknown().optional(),
});
export type ProjectCreatedEvent = z.infer<typeof ProjectCreatedEventSchema>;

export const ProjectUpdatedEventSchema = z.object({
  type: z.literal('project.updated'),
  project: ProjectBroadcastSummarySchema,
});
export type ProjectUpdatedEvent = z.infer<typeof ProjectUpdatedEventSchema>;

export const ProjectDeletedEventSchema = z.object({
  type: z.literal('project.deleted'),
  projectId: z.string(),
  workspaceId: z.string(),
});
export type ProjectDeletedEvent = z.infer<typeof ProjectDeletedEventSchema>;

// ----------------------------------------------------------------------------
// App events
// ----------------------------------------------------------------------------

export const AppInstalledEventSchema = z.object({
  type: z.literal('app.installed'),
  app: AppBroadcastSummarySchema,
  ownerId: z.string(),
});
export type AppInstalledEvent = z.infer<typeof AppInstalledEventSchema>;

export const AppUpdatedEventSchema = z.object({
  type: z.literal('app.updated'),
  app: AppBroadcastSummarySchema,
  ownerId: z.string(),
});
export type AppUpdatedEvent = z.infer<typeof AppUpdatedEventSchema>;

export const AppUninstalledEventSchema = z.object({
  type: z.literal('app.uninstalled'),
  appId: z.string(),
  ownerId: z.string(),
});
export type AppUninstalledEvent = z.infer<typeof AppUninstalledEventSchema>;

// ----------------------------------------------------------------------------
// Discriminated union of all NavBar events
// ----------------------------------------------------------------------------

export const NavbarRealtimeEventSchema = z.discriminatedUnion('type', [
  AgentCreatedEventSchema,
  AgentUpdatedEventSchema,
  AgentDeletedEventSchema,
  WorkspaceCreatedNavbarEventSchema,
  WorkspaceUpdatedNavbarEventSchema,
  WorkspaceArchivedNavbarEventSchema,
  ProjectCreatedEventSchema,
  ProjectUpdatedEventSchema,
  ProjectDeletedEventSchema,
  AppInstalledEventSchema,
  AppUpdatedEventSchema,
  AppUninstalledEventSchema,
]);
export type NavbarRealtimeEvent = z.infer<typeof NavbarRealtimeEventSchema>;
