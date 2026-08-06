import type { ToolConfig } from '@teros/mca-sdk';
import { MakeError } from '../lib/errors';
import { accountApiJson, normalizeRegion } from '../lib/make-client';
import { getUserSecretsSafe, requireApiToken } from './_helpers';

const VERSION = '1.0.0';

interface RawRunResponse {
  executionId?: string;
  status?: string;
  outputs?: unknown;
}

/**
 * run-scenario — run a Make scenario on demand by id (requires MAKE_API_TOKEN).
 * POST is executed exactly once (the client never retries POSTs — a retried run
 * would fire the scenario twice).
 */
export const runScenarioTool: ToolConfig<
  { scenarioId: string; data?: Record<string, unknown>; responsive?: boolean },
  unknown
> = {
  description:
    'Run a Make.com scenario on demand by id (requires MAKE_API_TOKEN in user secrets). Pass optional `data` for the run inputs and `responsive: true` to wait for and return its outputs. Returns { scenarioId, executionId, status, responsive, outputs }.',
  parameters: {
    type: 'object',
    properties: {
      scenarioId: {
        type: 'string',
        description: 'The id of the scenario to run (from list-scenarios).',
      },
      data: {
        type: 'object',
        description: 'Optional input data passed to the scenario run.',
        additionalProperties: true,
      },
      responsive: {
        type: 'boolean',
        description: 'If true, wait for the run to finish and return its outputs (default false).',
      },
    },
    required: ['scenarioId'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    // Running a scenario fires downstream automations (like trigger-webhook) but
    // does not itself delete/overwrite state irreversibly → not "destructive".
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);

    const scenarioId = String(args.scenarioId ?? '').trim();
    if (!scenarioId) {
      throw new MakeError('BAD_REQUEST', 'scenarioId is required and must be a non-empty string');
    }

    const responsive = Boolean(args.responsive);
    const body: Record<string, unknown> = {};
    if (args.data !== undefined) body.data = args.data;
    if (args.responsive !== undefined) body.responsive = responsive;

    const raw = await accountApiJson<RawRunResponse>(
      'POST',
      `/scenarios/${encodeURIComponent(scenarioId)}/run`,
      { apiKey, region, body, signal: context.signal },
    );

    return {
      scenarioId,
      executionId: raw.executionId ?? null,
      status: raw.status ?? null,
      responsive,
      outputs: raw.outputs ?? null,
    };
  },
};
