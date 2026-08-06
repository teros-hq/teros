/**
 * Unit tests — WS project handlers (create, list, get, update, delete, set-channel-project)
 *
 * TER-509: cross-workspace authz. Every handler must gate access through
 * canAccessWorkspace (ownership OR membership). A user with neither must be
 * rejected with FORBIDDEN *before* any read/write side effect on a project
 * (or channel) that does not belong to a workspace they can access.
 *
 * The tests bite: in every FORBIDDEN case we assert the destructive/write op
 * was NOT executed (delete/update/create never called, channels.updateOne never
 * called) and that the thrown error carries code 'FORBIDDEN'.
 *
 * No real MongoDB — Db and ProjectService are mocked. The Db mock is faithful
 * to canAccessWorkspace: it queries workspaces.findOne({workspaceId}) (owner)
 * and workspace_members.findOne({workspaceId, userId}) (membership).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createCreateProjectHandler } from '../../src/handlers/domains/project/create';
import { createListProjectsHandler } from '../../src/handlers/domains/project/list';
import { createGetProjectHandler } from '../../src/handlers/domains/project/get';
import { createUpdateProjectHandler } from '../../src/handlers/domains/project/update';
import { createDeleteProjectHandler } from '../../src/handlers/domains/project/delete';
import { createSetChannelProjectHandler } from '../../src/handlers/domains/project/set-channel-project';
import type { ProjectService } from '../../src/services/project-service';
import type { Project } from '../../src/types/database';

const USER_ALICE = 'user_alice';
const USER_BOB = 'user_bob';
const WORKSPACE_ALICE = 'work_alice';
const WORKSPACE_BOB = 'work_bob';
const PROJECT_ALICE = 'proj_alice';
const PROJECT_BOB = 'proj_bob';
const BOARD_ID = 'board_test';
const CHANNEL_ALICE = 'ch_alice';
const CHANNEL_BOB = 'ch_bob';

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    projectId: PROJECT_ALICE,
    workspaceId: WORKSPACE_ALICE,
    name: 'Test Project',
    boardId: BOARD_ID,
    status: 'active',
    createdBy: USER_ALICE,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: 'conn_test', sessionId: 'sess_test' } as WsHandlerContext;
}

/**
 * Build a mock Db faithful to canAccessWorkspace:
 *  - workspace WORKSPACE_ALICE owned by USER_ALICE
 *  - workspace WORKSPACE_BOB owned by USER_BOB
 *  - no memberships (no cross-workspace access)
 *  - channels: CHANNEL_ALICE owned by USER_ALICE, CHANNEL_BOB owned by USER_BOB
 *
 * The returned `updateOne` mock on `channels` is exposed via the closure so a
 * test can assert it was NOT called in FORBIDDEN paths.
 */
function makeDb(channelsUpdateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }))) {
  const collection = mock((name: string) => {
    const collections: Record<string, any> = {
      workspaces: {
        findOne: mock(async (filter: any) => {
          if (filter.workspaceId === WORKSPACE_ALICE) {
            return { workspaceId: WORKSPACE_ALICE, ownerId: USER_ALICE, status: 'active' };
          }
          if (filter.workspaceId === WORKSPACE_BOB) {
            return { workspaceId: WORKSPACE_BOB, ownerId: USER_BOB, status: 'active' };
          }
          return null;
        }),
      },
      workspace_members: {
        findOne: mock(async () => null),
        find: mock(() => ({ toArray: mock(async () => []) })),
      },
      channels: {
        findOne: mock(async (filter: any) => {
          if (filter.channelId === CHANNEL_ALICE) {
            return { channelId: CHANNEL_ALICE, userId: USER_ALICE };
          }
          if (filter.channelId === CHANNEL_BOB) {
            return { channelId: CHANNEL_BOB, userId: USER_BOB };
          }
          return null;
        }),
        updateOne: channelsUpdateOne,
      },
    };
    return collections[name] ?? { findOne: mock(async () => null) };
  });
  return { collection } as any;
}

function makeProjectService(overrides: Partial<Record<keyof ProjectService, any>> = {}): ProjectService {
  return {
    create: mock(async () => makeProject()),
    list: mock(async () => [makeProject()]),
    get: mock(async () => makeProject()),
    update: mock(async () => makeProject()),
    delete: mock(async () => true),
    ...overrides,
  } as any;
}

describe('project.create handler', () => {
  it('FORBIDDEN: user without access to the target workspace cannot create', async () => {
    const svc = makeProjectService();
    const handler = createCreateProjectHandler(svc, makeDb());

    await expect(
      handler(ctx(USER_ALICE), { workspaceId: WORKSPACE_BOB, name: 'X', boardId: BOARD_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: the write must not have happened
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('happy: owner can create in their workspace', async () => {
    const createMock = mock(async () => makeProject());
    const svc = makeProjectService({ create: createMock });
    const handler = createCreateProjectHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), {
      workspaceId: WORKSPACE_ALICE,
      name: 'My Project',
      boardId: BOARD_ID,
    });

    expect(result).toMatchObject({ project: expect.any(Object) });
    expect(createMock).toHaveBeenCalledWith(WORKSPACE_ALICE, USER_ALICE, {
      name: 'My Project',
      boardId: BOARD_ID,
      description: undefined,
      context: undefined,
    });
  });
});

describe('project.list handler', () => {
  it('FORBIDDEN: user without access to the workspace cannot list', async () => {
    const svc = makeProjectService();
    const handler = createListProjectsHandler(svc, makeDb());

    await expect(
      handler(ctx(USER_ALICE), { workspaceId: WORKSPACE_BOB }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: list (data read of foreign workspace) must not have happened
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('happy: owner can list their workspace projects', async () => {
    const listMock = mock(async () => [makeProject()]);
    const svc = makeProjectService({ list: listMock });
    const handler = createListProjectsHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), { workspaceId: WORKSPACE_ALICE });

    expect(result).toMatchObject({ projects: expect.any(Array) });
    expect(listMock).toHaveBeenCalledWith(WORKSPACE_ALICE);
  });
});

describe('project.get handler', () => {
  it("FORBIDDEN: user cannot get a project in another user's workspace", async () => {
    const svc = makeProjectService({
      get: mock(async () => makeProject({ projectId: PROJECT_BOB, workspaceId: WORKSPACE_BOB })),
    });
    const handler = createGetProjectHandler(svc, makeDb());

    await expect(
      handler(ctx(USER_ALICE), { projectId: PROJECT_BOB }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('happy: owner can get their project', async () => {
    const svc = makeProjectService({ get: mock(async () => makeProject()) });
    const handler = createGetProjectHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), { projectId: PROJECT_ALICE });

    expect(result).toMatchObject({ project: expect.objectContaining({ projectId: PROJECT_ALICE }) });
  });
});

describe('project.update handler', () => {
  it("FORBIDDEN: user cannot update a project in another user's workspace", async () => {
    const updateMock = mock(async () => makeProject());
    const svc = makeProjectService({
      get: mock(async () => makeProject({ projectId: PROJECT_BOB, workspaceId: WORKSPACE_BOB })),
      update: updateMock,
    });
    const handler = createUpdateProjectHandler(svc, makeDb());

    await expect(
      handler(ctx(USER_ALICE), { projectId: PROJECT_BOB, name: 'hijacked' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: the write must not have happened (gate is before update)
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('happy: owner can update their project', async () => {
    const updateMock = mock(async () => makeProject({ name: 'Renamed' }));
    const svc = makeProjectService({ get: mock(async () => makeProject()), update: updateMock });
    const handler = createUpdateProjectHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), { projectId: PROJECT_ALICE, name: 'Renamed' });

    expect(result).toMatchObject({ project: expect.any(Object) });
    expect(updateMock).toHaveBeenCalledWith(PROJECT_ALICE, {
      name: 'Renamed',
      description: undefined,
      context: undefined,
    });
  });
});

describe('project.delete handler', () => {
  it("FORBIDDEN: user cannot delete a project in another user's workspace", async () => {
    const deleteMock = mock(async () => true);
    const svc = makeProjectService({
      get: mock(async () => makeProject({ projectId: PROJECT_BOB, workspaceId: WORKSPACE_BOB })),
      delete: deleteMock,
    });
    const handler = createDeleteProjectHandler(svc, makeDb());

    await expect(
      handler(ctx(USER_ALICE), { projectId: PROJECT_BOB }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: the destructive op must not have happened (gate is before delete)
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('happy: owner can delete their project', async () => {
    const deleteMock = mock(async () => true);
    const svc = makeProjectService({ get: mock(async () => makeProject()), delete: deleteMock });
    const handler = createDeleteProjectHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), { projectId: PROJECT_ALICE });

    expect(result).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith(PROJECT_ALICE);
  });
});

describe('project.set-channel-project handler', () => {
  it("FORBIDDEN: cannot reassign a channel owned by another user", async () => {
    const channelsUpdateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const svc = makeProjectService();
    const handler = createSetChannelProjectHandler(makeDb(channelsUpdateOne), svc);

    await expect(
      handler(ctx(USER_ALICE), { channelId: CHANNEL_BOB, projectId: PROJECT_ALICE }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: the channel reassociation must not have happened
    expect(channelsUpdateOne).not.toHaveBeenCalled();
  });

  it("FORBIDDEN: cannot associate own channel to a project in another user's workspace", async () => {
    const channelsUpdateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const svc = makeProjectService({
      get: mock(async () => makeProject({ projectId: PROJECT_BOB, workspaceId: WORKSPACE_BOB })),
    });
    const handler = createSetChannelProjectHandler(makeDb(channelsUpdateOne), svc);

    await expect(
      handler(ctx(USER_ALICE), { channelId: CHANNEL_ALICE, projectId: PROJECT_BOB }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // bite: the write must not have happened
    expect(channelsUpdateOne).not.toHaveBeenCalled();
  });

  it('CHANNEL_NOT_FOUND: unknown channel is rejected before any write', async () => {
    const channelsUpdateOne = mock(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    const svc = makeProjectService();
    const handler = createSetChannelProjectHandler(makeDb(channelsUpdateOne), svc);

    await expect(
      handler(ctx(USER_ALICE), { channelId: 'ch_ghost', projectId: PROJECT_ALICE }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });

    expect(channelsUpdateOne).not.toHaveBeenCalled();
  });

  it('happy: owner associates own channel to a project in their workspace', async () => {
    const channelsUpdateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const svc = makeProjectService({ get: mock(async () => makeProject()) });
    const handler = createSetChannelProjectHandler(makeDb(channelsUpdateOne), svc);

    const result = await handler(ctx(USER_ALICE), {
      channelId: CHANNEL_ALICE,
      projectId: PROJECT_ALICE,
    });

    expect(result).toEqual({ ok: true });
    expect(channelsUpdateOne).toHaveBeenCalledWith(
      { channelId: CHANNEL_ALICE },
      { $set: { projectId: PROJECT_ALICE } },
    );
  });

  it('happy: owner disassociates own channel (no projectId) without a project access check', async () => {
    const channelsUpdateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const getMock = mock(async () => makeProject());
    const svc = makeProjectService({ get: getMock });
    const handler = createSetChannelProjectHandler(makeDb(channelsUpdateOne), svc);

    const result = await handler(ctx(USER_ALICE), { channelId: CHANNEL_ALICE, projectId: null });

    expect(result).toEqual({ ok: true });
    // disassociate path does not look up a project
    expect(getMock).not.toHaveBeenCalled();
    expect(channelsUpdateOne).toHaveBeenCalledWith(
      { channelId: CHANNEL_ALICE },
      { $unset: { projectId: '' } },
    );
  });
});
