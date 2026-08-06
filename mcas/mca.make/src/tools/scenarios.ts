import type { ToolConfig } from '@teros/mca-sdk';
import { MakeError } from '../lib/errors';
import { accountApiJson, normalizeRegion } from '../lib/make-client';
import { getUserSecretsSafe, requireApiToken } from './_helpers';

const VERSION = '2.0.0';

interface RawScenario {
  id?: number | string;
  name?: string;
  isActive?: boolean;
  teamId?: number | string;
  folderId?: number | string | null;
  /** Make returns the API URL of the scenario under `url` on some endpoints. */
  url?: string;
  region?: string;
  /** Full blueprint payload returned by GET /scenarios/{id}/blueprint. */
  blueprint?: string | Record<string, unknown>;
  scheduling?: Record<string, unknown>;
  // Allow any extra upstream fields for forward-compatibility.
  [key: string]: unknown;
}

/** Validate that a scenario id argument is a non-empty string. */
function requireScenarioId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!id) throw new MakeError('BAD_REQUEST', 'scenarioId is required and must be a non-empty string');
  return id;
}

/** Validate that a team id argument is a non-empty string. */
function requireTeamId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!id) throw new MakeError('BAD_REQUEST', 'teamId is required and must be a non-empty string');
  return id;
}

/** Normalize a raw scenario id to string. */
function strId(value: number | string | undefined | null): string | null {
  return value != null ? String(value) : null;
}

/**
 * create-scenario — create a new Make scenario (requires MAKE_API_TOKEN).
 * POST /v2/scenarios
 */
export const createScenarioTool: ToolConfig<
  {
    teamId: string;
    name?: string;
    blueprint: Record<string, unknown>;
    scheduling?: Record<string, unknown>;
    folderId?: string;
    confirmed?: boolean;
    basedon?: string;
  },
  unknown
> = {
  description:
    'Create a new Make.com scenario (requires MAKE_API_TOKEN in user secrets). The `blueprint` is provided as a JSON object and is serialized internally. Returns { scenarioId, name, teamId, folderId, isActive, region, url }. Some Make plans require a paid subscription to use this endpoint.',
  parameters: {
    type: 'object',
    properties: {
      teamId: {
        type: 'string',
        description: 'Make team id that will own the scenario.',
      },
      name: {
        type: 'string',
        description: 'Human-readable name for the scenario.',
      },
      blueprint: {
        type: 'object',
        description:
          'Scenario blueprint as a JSON object (not an escaped string). It will be serialized to a string before sending to Make.',
        additionalProperties: true,
      },
      scheduling: {
        type: 'object',
        description: 'Scheduling configuration. Defaults to { type: "indefinitely", interval: 60 }.',
        additionalProperties: true,
      },
      folderId: {
        type: 'string',
        description: 'Optional folder id to place the scenario in.',
      },
      confirmed: {
        type: 'boolean',
        description: 'Whether the scenario is confirmed on creation (default true).',
      },
      basedon: {
        type: 'string',
        description: 'Optional id of an existing scenario to base this one on.',
      },
    },
    required: ['teamId', 'blueprint'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);

    const teamId = requireTeamId(args.teamId);
    if (args.blueprint == null || typeof args.blueprint !== 'object' || Array.isArray(args.blueprint)) {
      throw new MakeError('BAD_REQUEST', 'blueprint is required and must be a JSON object');
    }
    const body: Record<string, unknown> = {
      teamId,
      blueprint: JSON.stringify(args.blueprint),
      scheduling: args.scheduling ?? { type: 'indefinitely', interval: 60 },
      confirmed: args.confirmed !== false,
    };
    if (args.name !== undefined && args.name !== '') body.name = args.name;
    if (args.folderId !== undefined && args.folderId !== '') body.folderId = args.folderId;
    if (args.basedon !== undefined && args.basedon !== '') body.basedon = args.basedon;

    const raw = await accountApiJson<RawScenario>('POST', '/scenarios', {
      apiKey,
      region,
      body,
      signal: context.signal,
    });

    return {
      scenarioId: strId(raw.id),
      name: raw.name ?? null,
      teamId: strId(raw.teamId) ?? teamId,
      folderId: strId(raw.folderId),
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : null,
      region,
      url: raw.url ?? null,
    };
  },
};

/**
 * get-scenario — read a single Make scenario (requires MAKE_API_TOKEN).
 * GET /v2/scenarios/{id}
 */
export const getScenarioTool: ToolConfig<{ scenarioId: string }, unknown> = {
  description:
    'Get a single Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Returns the scenario object as returned by Make.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to retrieve.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const raw = await accountApiJson<RawScenario>(
      'GET',
      `/scenarios/${encodeURIComponent(scenarioId)}`,
      { apiKey, region, signal: context.signal },
    );

    return {
      scenarioId: strId(raw.id) ?? scenarioId,
      name: raw.name ?? null,
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : null,
      teamId: strId(raw.teamId),
      folderId: strId(raw.folderId),
      region,
      raw,
    };
  },
};

/**
 * get-scenario-blueprint — fetch the blueprint of a scenario (requires MAKE_API_TOKEN).
 * GET /v2/scenarios/{id}/blueprint
 */
export const getScenarioBlueprintTool: ToolConfig<{ scenarioId: string }, unknown> = {
  description:
    'Get the blueprint of a Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Returns { scenarioId, blueprint } where blueprint is a parsed JSON object when possible.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario whose blueprint to retrieve.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const raw = await accountApiJson<RawScenario>(
      'GET',
      `/scenarios/${encodeURIComponent(scenarioId)}/blueprint`,
      { apiKey, region, signal: context.signal },
    );

    let blueprint: unknown = raw.blueprint ?? null;
    if (typeof blueprint === 'string') {
      try {
        blueprint = JSON.parse(blueprint);
      } catch {
        // Leave as raw string if it is not valid JSON.
      }
    }

    return { scenarioId, blueprint, region };
  },
};

/**
 * update-scenario — update an existing scenario (requires MAKE_API_TOKEN).
 * PATCH /v2/scenarios/{id}
 */
export const updateScenarioTool: ToolConfig<
  {
    scenarioId: string;
    name?: string;
    blueprint?: Record<string, unknown>;
    scheduling?: Record<string, unknown>;
    folderId?: string;
  },
  unknown
> = {
  description:
    'Update an existing Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Supports updating name, blueprint (as a JSON object), scheduling, and folderId. Returns the updated scenario summary.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to update.',
      },
      name: {
        type: 'string',
        description: 'New name for the scenario.',
      },
      blueprint: {
        type: 'object',
        description:
          'New scenario blueprint as a JSON object (not an escaped string). It will be serialized to a string before sending to Make.',
        additionalProperties: true,
      },
      scheduling: {
        type: 'object',
        description: 'New scheduling configuration.',
        additionalProperties: true,
      },
      folderId: {
        type: 'string',
        description: 'New folder id for the scenario.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const body: Record<string, unknown> = {};
    if (args.name !== undefined && args.name !== '') body.name = args.name;
    if (args.blueprint !== undefined) body.blueprint = JSON.stringify(args.blueprint);
    if (args.scheduling !== undefined) body.scheduling = args.scheduling;
    if (args.folderId !== undefined && args.folderId !== '') body.folderId = args.folderId;

    if (Object.keys(body).length === 0) {
      throw new MakeError('BAD_REQUEST', 'At least one field to update must be provided');
    }

    const raw = await accountApiJson<RawScenario>(
      'PATCH',
      `/scenarios/${encodeURIComponent(scenarioId)}`,
      { apiKey, region, body, signal: context.signal },
    );

    return {
      scenarioId: strId(raw.id) ?? scenarioId,
      name: raw.name ?? null,
      teamId: strId(raw.teamId),
      folderId: strId(raw.folderId),
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : null,
      region,
      url: raw.url ?? null,
    };
  },
};

/**
 * delete-scenario — delete a scenario (requires MAKE_API_TOKEN).
 * DELETE /v2/scenarios/{id}
 */
export const deleteScenarioTool: ToolConfig<{ scenarioId: string }, unknown> = {
  description:
    'Delete a Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). This action is irreversible. Returns { scenarioId, deleted, region }.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to delete.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    await accountApiJson<unknown>(
      'DELETE',
      `/scenarios/${encodeURIComponent(scenarioId)}`,
      { apiKey, region, signal: context.signal },
    );

    return { scenarioId, deleted: true, region };
  },
};

/**
 * clone-scenario — clone an existing scenario (requires MAKE_API_TOKEN).
 * POST /v2/scenarios/{id}/clone
 */
export const cloneScenarioTool: ToolConfig<{ scenarioId: string; name?: string; folderId?: string }, unknown> = {
  description:
    'Clone an existing Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Optionally set a new name or folder. Returns the cloned scenario summary.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to clone.',
      },
      name: {
        type: 'string',
        description: 'Optional new name for the cloned scenario.',
      },
      folderId: {
        type: 'string',
        description: 'Optional folder id for the cloned scenario.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const body: Record<string, unknown> = {};
    if (args.name !== undefined && args.name !== '') body.name = args.name;
    if (args.folderId !== undefined && args.folderId !== '') body.folderId = args.folderId;

    const raw = await accountApiJson<RawScenario>(
      'POST',
      `/scenarios/${encodeURIComponent(scenarioId)}/clone`,
      { apiKey, region, body, signal: context.signal },
    );

    return {
      scenarioId: strId(raw.id),
      name: raw.name ?? null,
      teamId: strId(raw.teamId),
      folderId: strId(raw.folderId),
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : null,
      region,
      url: raw.url ?? null,
    };
  },
};

/**
 * start-scenario — activate a scenario (requires MAKE_API_TOKEN).
 * POST /v2/scenarios/{id}/start
 */
export const startScenarioTool: ToolConfig<{ scenarioId: string }, unknown> = {
  description:
    'Activate (start) a Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Returns { scenarioId, isActive, region }.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to activate.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const raw = await accountApiJson<RawScenario>(
      'POST',
      `/scenarios/${encodeURIComponent(scenarioId)}/start`,
      { apiKey, region, signal: context.signal },
    );

    return {
      scenarioId: strId(raw.id) ?? scenarioId,
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : true,
      region,
    };
  },
};

/**
 * stop-scenario — pause a scenario (requires MAKE_API_TOKEN).
 * POST /v2/scenarios/{id}/stop
 */
export const stopScenarioTool: ToolConfig<{ scenarioId: string }, unknown> = {
  description:
    'Pause (stop) a Make.com scenario by id (requires MAKE_API_TOKEN in user secrets). Returns { scenarioId, isActive, region }.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to pause.',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);
    const scenarioId = requireScenarioId(args.scenarioId);

    const raw = await accountApiJson<RawScenario>(
      'POST',
      `/scenarios/${encodeURIComponent(scenarioId)}/stop`,
      { apiKey, region, signal: context.signal },
    );

    return {
      scenarioId: strId(raw.id) ?? scenarioId,
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : false,
      region,
    };
  },
};
