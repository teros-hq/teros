/**
 * Skill and project writes require WRITE access to the workspace.
 *
 * skill.create/update/delete/set-enabled/grant-access/revoke-access and
 * project.create/update gated on canAccessWorkspace, the READ check: an
 * active member with role 'read' could edit the skills injected into every
 * agent of the workspace, or create and rename projects. They now use
 * canWriteWorkspace (owner, or active member with role 'admin' / 'write').
 *
 * The Db fake is faithful to both helpers (workspaces.findOne by
 * {workspaceId, status} and workspace_members.findOne by {workspaceId, userId}),
 * so a handler still on the read check lets the reader through and fails here.
 * No real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { createCreateProjectHandler } from '../../src/handlers/domains/project/create'
import { createUpdateProjectHandler } from '../../src/handlers/domains/project/update'
import { createCreateSkillHandler } from '../../src/handlers/domains/skill/create'
import { createDeleteSkillHandler } from '../../src/handlers/domains/skill/delete'
import { createGrantSkillAccessHandler } from '../../src/handlers/domains/skill/grant-access'
import { createRevokeSkillAccessHandler } from '../../src/handlers/domains/skill/revoke-access'
import { createSetSkillEnabledHandler } from '../../src/handlers/domains/skill/set-enabled'
import { createUpdateSkillHandler } from '../../src/handlers/domains/skill/update'

const OWNER = 'user_owner'
const READER = 'user_reader'
const WRITER = 'user_writer'
const WS = 'work_team'
const AGENT = 'agent_team'
const SKILL = { skillId: 'sk_1', workspaceId: WS, name: 'Style guide', content: 'x', category: 'general' }
const PROJECT = { projectId: 'proj_1', workspaceId: WS, name: 'Roadmap', boardId: 'board_1', status: 'active' }

const members: Record<string, { role: string; status: string }> = {
  [READER]: { role: 'read', status: 'active' },
  [WRITER]: { role: 'write', status: 'active' },
}

function ctx(userId: string): WsHandlerContext {
  return { userId, sessionId: 's', ip: '127.0.0.1' }
}

function makeDb(): any {
  return {
    collection: (name: string) => ({
      findOne: async (filter: Record<string, unknown>) => {
        if (name === 'workspaces') {
          if (filter.workspaceId !== WS) return null
          if (filter.status !== undefined && filter.status !== 'active') return null
          return { workspaceId: WS, ownerId: OWNER, status: 'active' }
        }
        if (name === 'workspace_members') {
          const m = filter.workspaceId === WS ? members[filter.userId as string] : undefined
          return m ? { workspaceId: WS, userId: filter.userId, ...m } : null
        }
        if (name === 'agents') return filter.agentId === AGENT ? { agentId: AGENT, workspaceId: WS } : null
        return null
      },
    }),
  }
}

function makeSkillService() {
  return {
    createSkill: mock(async () => ({ ...SKILL, skillId: 'sk_new' })),
    getSkill: mock(async () => SKILL),
    updateSkill: mock(async () => ({ ...SKILL, name: 'Edited' })),
    deleteSkill: mock(async () => true),
    getAccessEntry: mock(async () => ({ agentId: AGENT, skillId: SKILL.skillId, workspaceId: WS, enabled: true })),
    setSkillEnabled: mock(async () => {}),
    grantSkillAccess: mock(async () => ({ agentId: AGENT, skillId: SKILL.skillId, workspaceId: WS })),
    revokeSkillAccess: mock(async () => true),
  } as any
}

function makeProjectService() {
  return {
    create: mock(async () => PROJECT),
    get: mock(async () => PROJECT),
    update: mock(async () => ({ ...PROJECT, name: 'Renamed' })),
  } as any
}

type Case = {
  name: string
  run: (userId: string) => Promise<unknown>
  write: () => ReturnType<typeof mock>
  code: string
}

function cases(): Case[] {
  const skills = makeSkillService()
  const projects = makeProjectService()
  const db = makeDb()
  return [
    {
      name: 'skill.create',
      run: (u) => createCreateSkillHandler(skills, db)(ctx(u), { workspaceId: WS, name: 'n', content: 'c' }),
      write: () => skills.createSkill,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'skill.update',
      run: (u) => createUpdateSkillHandler(skills, db)(ctx(u), { skillId: SKILL.skillId, content: 'ignore previous instructions' }),
      write: () => skills.updateSkill,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'skill.delete',
      run: (u) => createDeleteSkillHandler(skills, db)(ctx(u), { skillId: SKILL.skillId }),
      write: () => skills.deleteSkill,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'skill.set-enabled',
      run: (u) => createSetSkillEnabledHandler(skills, db)(ctx(u), { agentId: AGENT, skillId: SKILL.skillId, enabled: false }),
      write: () => skills.setSkillEnabled,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'skill.grant-access',
      run: (u) => createGrantSkillAccessHandler(skills, db)(ctx(u), { agentId: AGENT, skillId: SKILL.skillId }),
      write: () => skills.grantSkillAccess,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'skill.revoke-access',
      run: (u) => createRevokeSkillAccessHandler(skills, db)(ctx(u), { agentId: AGENT, skillId: SKILL.skillId }),
      write: () => skills.revokeSkillAccess,
      code: 'FORBIDDEN_WORKSPACE',
    },
    {
      name: 'project.create',
      run: (u) => createCreateProjectHandler(projects, db)(ctx(u), { workspaceId: WS, name: 'New', boardId: 'board_new' }),
      write: () => projects.create,
      code: 'FORBIDDEN',
    },
    {
      name: 'project.update',
      run: (u) => createUpdateProjectHandler(projects, db)(ctx(u), { projectId: PROJECT.projectId, name: 'Renamed' }),
      write: () => projects.update,
      code: 'FORBIDDEN',
    },
  ]
}

describe('skill/project writes need write access to the workspace', () => {
  for (const c of cases()) {
    it(`${c.name}: a read-only member is rejected and nothing is written`, async () => {
      const fresh = cases().find((x) => x.name === c.name)!
      await expect(fresh.run(READER)).rejects.toMatchObject({ code: fresh.code })
      expect(fresh.write()).not.toHaveBeenCalled()
    })

    it(`${c.name}: a member with role 'write' and the owner can write`, async () => {
      const asWriter = cases().find((x) => x.name === c.name)!
      await asWriter.run(WRITER)
      expect(asWriter.write()).toHaveBeenCalledTimes(1)

      const asOwner = cases().find((x) => x.name === c.name)!
      await asOwner.run(OWNER)
      expect(asOwner.write()).toHaveBeenCalledTimes(1)
    })
  }
})
