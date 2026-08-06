/**
 * WS skill CRUD handlers — contract-boundary (TER-481, completa skill-handlers.test.ts).
 *
 * skill-handlers.test.ts ya cubre grant/revoke/set-enabled (que SÍ verificaban
 * authz). Este cubre create/list/get/update/delete/reorder/get-agent-skills,
 * que NO verificaban nada → cualquier usuario autenticado podía leer/editar/
 * borrar cualquier skill por ID o listar/crear en cualquier workspace
 * (SkillService opera por id/workspaceId sin scoping). El fix añade gates:
 *   - create/list  → canAccessWorkspace(workspaceId)
 *   - get/update/delete → load skill + canAccessWorkspace(skill.workspaceId)
 *   - reorder/get-agent-skills → canAccessAgent(agentId)
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createCreateSkillHandler } from '../../src/handlers/domains/skill/create';
import { createListSkillsHandler } from '../../src/handlers/domains/skill/list';
import { createGetSkillHandler } from '../../src/handlers/domains/skill/get';
import { createUpdateSkillHandler } from '../../src/handlers/domains/skill/update';
import { createDeleteSkillHandler } from '../../src/handlers/domains/skill/delete';
import { createReorderSkillsHandler } from '../../src/handlers/domains/skill/reorder';
import { createGetAgentSkillsHandler } from '../../src/handlers/domains/skill/get-agent-skills';

const USER_ALICE = 'user_alice';
const USER_BOB = 'user_bob';
const WS_ALICE = 'work_alice';
const WS_BOB = 'work_bob';
const AGENT_ALICE = 'agent_alice';
const AGENT_BOB = 'agent_bob';

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: 'sess', connectionId: 'conn' }) as any;

/** db fiel a canAccessWorkspace (workspaces.ownerId + workspace_members) y canAccessAgent (agents). */
function makeDb() {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === 'workspaces') {
          if (filter.workspaceId === WS_ALICE) return { workspaceId: WS_ALICE, ownerId: USER_ALICE, status: 'active' };
          if (filter.workspaceId === WS_BOB) return { workspaceId: WS_BOB, ownerId: USER_BOB, status: 'active' };
          return null;
        }
        if (name === 'workspace_members') return null;
        if (name === 'agents') {
          if (filter.agentId === AGENT_ALICE) return { agentId: AGENT_ALICE, workspaceId: WS_ALICE, ownerId: USER_ALICE };
          if (filter.agentId === AGENT_BOB) return { agentId: AGENT_BOB, workspaceId: WS_BOB, ownerId: USER_BOB };
          return null;
        }
        return null;
      },
    }),
  } as any;
}

const SKILL_ALICE = { skillId: 'sk_1', workspaceId: WS_ALICE, name: 'A', content: 'x', category: 'general' };

function makeSkillService(over: any = {}) {
  return {
    createSkill: mock(async () => ({ skillId: 'sk_new', name: 'A', workspaceId: WS_ALICE })),
    listSkills: mock(async () => [SKILL_ALICE]),
    getSkill: mock(async () => SKILL_ALICE),
    updateSkill: mock(async () => ({ ...SKILL_ALICE, name: 'A2' })),
    deleteSkill: mock(async () => true),
    reorderAgentSkills: mock(async () => {}),
    getAgentSkills: mock(async () => [SKILL_ALICE]),
    ...over,
  } as any;
}

// ---------------------------------------------------------------------------
// skill.create — workspace-sovereign
// ---------------------------------------------------------------------------

describe('skill.create', () => {
  it('MISSING_WORKSPACE_ID / MISSING_NAME / MISSING_CONTENT', async () => {
    const h = createCreateSkillHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), { name: 'x', content: 'c' })).rejects.toMatchObject({ code: 'MISSING_WORKSPACE_ID' });
    await expect(h(ctx(USER_ALICE), { workspaceId: WS_ALICE, content: 'c' })).rejects.toMatchObject({ code: 'MISSING_NAME' });
    await expect(h(ctx(USER_ALICE), { workspaceId: WS_ALICE, name: 'x' })).rejects.toMatchObject({ code: 'MISSING_CONTENT' });
  });

  it('content="" es válido (boundary: vacío no es ausente)', async () => {
    const svc = makeSkillService();
    const h = createCreateSkillHandler(svc, makeDb());
    await h(ctx(USER_ALICE), { workspaceId: WS_ALICE, name: 'x', content: '' });
    expect(svc.createSkill).toHaveBeenCalledWith(WS_ALICE, USER_ALICE, {
      name: 'x', description: undefined, content: '', category: undefined, tags: undefined,
    });
  });

  it('FORBIDDEN_WORKSPACE para no-miembro y NO crea', async () => {
    const svc = makeSkillService();
    const h = createCreateSkillHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { workspaceId: WS_ALICE, name: 'x', content: 'c' })).rejects.toMatchObject({
      code: 'FORBIDDEN_WORKSPACE',
    });
    expect(svc.createSkill).not.toHaveBeenCalled();
  });

  it('owner del workspace → crea y devuelve {skill}', async () => {
    const h = createCreateSkillHandler(makeSkillService(), makeDb());
    const res = await h(ctx(USER_ALICE), { workspaceId: WS_ALICE, name: 'x', content: 'c' });
    expect(res).toEqual({ skill: { skillId: 'sk_new', name: 'A', workspaceId: WS_ALICE } });
  });
});

// ---------------------------------------------------------------------------
// skill.list — workspace-sovereign
// ---------------------------------------------------------------------------

describe('skill.list', () => {
  it('MISSING_WORKSPACE_ID', async () => {
    const h = createListSkillsHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), {})).rejects.toMatchObject({ code: 'MISSING_WORKSPACE_ID' });
  });

  it('FORBIDDEN_WORKSPACE para no-miembro y NO lista', async () => {
    const svc = makeSkillService();
    const h = createListSkillsHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { workspaceId: WS_ALICE })).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(svc.listSkills).not.toHaveBeenCalled();
  });

  it('owner → {skills}', async () => {
    const h = createListSkillsHandler(makeSkillService(), makeDb());
    const res = await h(ctx(USER_ALICE), { workspaceId: WS_ALICE });
    expect(res).toEqual({ skills: [SKILL_ALICE] });
  });
});

// ---------------------------------------------------------------------------
// skill.get — load + workspace-sovereign
// ---------------------------------------------------------------------------

describe('skill.get', () => {
  it('MISSING_SKILL_ID', async () => {
    const h = createGetSkillHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), {})).rejects.toMatchObject({ code: 'MISSING_SKILL_ID' });
  });

  it('SKILL_NOT_FOUND si no existe (sin filtrar authz del workspace inexistente)', async () => {
    const h = createGetSkillHandler(makeSkillService({ getSkill: mock(async () => null) }), makeDb());
    await expect(h(ctx(USER_ALICE), { skillId: 'sk_x' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });

  it('FORBIDDEN_WORKSPACE si el skill es de otro workspace (no leer contenido ajeno)', async () => {
    const h = createGetSkillHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_BOB), { skillId: 'sk_1' })).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
  });

  it('miembro del workspace del skill → {skill}', async () => {
    const h = createGetSkillHandler(makeSkillService(), makeDb());
    const res = await h(ctx(USER_ALICE), { skillId: 'sk_1' });
    expect(res).toEqual({ skill: SKILL_ALICE });
  });
});

// ---------------------------------------------------------------------------
// skill.update — load + authz ANTES de mutar
// ---------------------------------------------------------------------------

describe('skill.update', () => {
  it('MISSING_SKILL_ID', async () => {
    const h = createUpdateSkillHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), { name: 'x' })).rejects.toMatchObject({ code: 'MISSING_SKILL_ID' });
  });

  it('SKILL_NOT_FOUND si no existe (no llama updateSkill)', async () => {
    const svc = makeSkillService({ getSkill: mock(async () => null) });
    const h = createUpdateSkillHandler(svc, makeDb());
    await expect(h(ctx(USER_ALICE), { skillId: 'sk_x', name: 'y' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    expect(svc.updateSkill).not.toHaveBeenCalled();
  });

  it('FORBIDDEN_WORKSPACE de otro workspace y NO muta (authz antes del write)', async () => {
    const svc = makeSkillService();
    const h = createUpdateSkillHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { skillId: 'sk_1', name: 'hacked' })).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(svc.updateSkill).not.toHaveBeenCalled();
  });

  it('miembro → muta y devuelve {skill}', async () => {
    const svc = makeSkillService();
    const h = createUpdateSkillHandler(svc, makeDb());
    const res = await h(ctx(USER_ALICE), { skillId: 'sk_1', name: 'A2' });
    expect(res).toEqual({ skill: { ...SKILL_ALICE, name: 'A2' } });
    expect(svc.updateSkill).toHaveBeenCalledWith('sk_1', {
      name: 'A2', description: undefined, content: undefined, category: undefined, tags: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// skill.delete — load + authz ANTES de borrar
// ---------------------------------------------------------------------------

describe('skill.delete', () => {
  it('MISSING_SKILL_ID', async () => {
    const h = createDeleteSkillHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), {})).rejects.toMatchObject({ code: 'MISSING_SKILL_ID' });
  });

  it('SKILL_NOT_FOUND si no existe (no llama deleteSkill)', async () => {
    const svc = makeSkillService({ getSkill: mock(async () => null) });
    const h = createDeleteSkillHandler(svc, makeDb());
    await expect(h(ctx(USER_ALICE), { skillId: 'sk_x' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    expect(svc.deleteSkill).not.toHaveBeenCalled();
  });

  it('FORBIDDEN_WORKSPACE de otro workspace y NO borra (authz antes del delete)', async () => {
    const svc = makeSkillService();
    const h = createDeleteSkillHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { skillId: 'sk_1' })).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
    expect(svc.deleteSkill).not.toHaveBeenCalled();
  });

  it('miembro → borra y {success:true}', async () => {
    const svc = makeSkillService();
    const res = await createDeleteSkillHandler(svc, makeDb())(ctx(USER_ALICE), { skillId: 'sk_1' });
    expect(res).toEqual({ success: true });
    expect(svc.deleteSkill).toHaveBeenCalledWith('sk_1');
  });
});

// ---------------------------------------------------------------------------
// skill.reorder / get-agent-skills — agent-sovereign
// ---------------------------------------------------------------------------

describe('skill.reorder', () => {
  it('MISSING_AGENT_ID / MISSING_ORDERED_SKILL_IDS (no-array)', async () => {
    const h = createReorderSkillsHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), { orderedSkillIds: [] })).rejects.toMatchObject({ code: 'MISSING_AGENT_ID' });
    await expect(h(ctx(USER_ALICE), { agentId: AGENT_ALICE, orderedSkillIds: 'x' })).rejects.toMatchObject({
      code: 'MISSING_ORDERED_SKILL_IDS',
    });
  });

  it('FORBIDDEN_AGENT si el agente es de otro workspace y NO reordena', async () => {
    const svc = makeSkillService();
    const h = createReorderSkillsHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { agentId: AGENT_ALICE, orderedSkillIds: ['sk_1'] })).rejects.toMatchObject({
      code: 'FORBIDDEN_AGENT',
    });
    expect(svc.reorderAgentSkills).not.toHaveBeenCalled();
  });

  it('orderedSkillIds=[] (vacío) es válido para un miembro → reordena con []', async () => {
    const svc = makeSkillService();
    const res = await createReorderSkillsHandler(svc, makeDb())(ctx(USER_ALICE), { agentId: AGENT_ALICE, orderedSkillIds: [] });
    expect(res).toEqual({ success: true });
    expect(svc.reorderAgentSkills).toHaveBeenCalledWith(AGENT_ALICE, []);
  });
});

describe('skill.get-agent-skills', () => {
  it('MISSING_AGENT_ID', async () => {
    const h = createGetAgentSkillsHandler(makeSkillService(), makeDb());
    await expect(h(ctx(USER_ALICE), {})).rejects.toMatchObject({ code: 'MISSING_AGENT_ID' });
  });

  it('FORBIDDEN_AGENT de otro workspace y NO lee', async () => {
    const svc = makeSkillService();
    const h = createGetAgentSkillsHandler(svc, makeDb());
    await expect(h(ctx(USER_BOB), { agentId: AGENT_ALICE })).rejects.toMatchObject({ code: 'FORBIDDEN_AGENT' });
    expect(svc.getAgentSkills).not.toHaveBeenCalled();
  });

  it('miembro → {skills}', async () => {
    const res = await createGetAgentSkillsHandler(makeSkillService(), makeDb())(ctx(USER_ALICE), { agentId: AGENT_ALICE });
    expect(res).toEqual({ skills: [SKILL_ALICE] });
  });
});
