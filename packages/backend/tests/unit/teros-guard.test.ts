/**
 * Teros Guard — Fase 1 (docs/specs/security/20261106_teros-guard.md)
 *
 * Covers:
 *   1. applyGuardVerdict (pure policy, types/permissions.ts): the three
 *      verdicts × headless/no-headless × non-allow pass-through.
 *   2. parseVerdict (tolerant JSON parse of the guard model output).
 *   3. The executor hook: flag OFF = zero change; flag ON + watched app →
 *      guard verdict applied (block denies with reason, force_ask enters the
 *      ask flow with guardReason, headless force_ask collapses to deny).
 */

import { describe, expect, it, mock } from 'bun:test';
import { applyGuardVerdict } from '../../src/types/permissions';
import { parseVerdict } from '../../src/services/teros-guard-service';
import { McaToolExecutor } from '../../src/services/mca-tool-executor';
import type { McaManager } from '../../src/services/mca-manager';
import type { McaService } from '../../src/services/mca-service';
import type { GuardEvaluation } from '../../src/services/teros-guard-service';

describe('applyGuardVerdict — pure verdict mapping (design §2.1/§3)', () => {
  it('pass keeps allow (no friction)', () => {
    expect(applyGuardVerdict('allow', 'pass', false)).toBe('allow');
    expect(applyGuardVerdict('allow', 'pass', true)).toBe('allow');
  });

  it('block → forbid (denied by the guard)', () => {
    expect(applyGuardVerdict('allow', 'block', false)).toBe('forbid');
    expect(applyGuardVerdict('allow', 'block', true)).toBe('forbid');
  });

  it('force_ask → ask with a human watching', () => {
    expect(applyGuardVerdict('allow', 'force_ask', false)).toBe('ask');
  });

  it('force_ask collapses to forbid headless (TER-157 honest auto-deny)', () => {
    expect(applyGuardVerdict('allow', 'force_ask', true)).toBe('forbid');
  });

  it('NEVER upgrades: ask/forbid pass through untouched (guard only degrades)', () => {
    expect(applyGuardVerdict('ask', 'pass', false)).toBe('ask');
    expect(applyGuardVerdict('ask', 'block', true)).toBe('ask');
    expect(applyGuardVerdict('forbid', 'pass', false)).toBe('forbid');
    expect(applyGuardVerdict('forbid', 'force_ask', false)).toBe('forbid');
  });
});

describe('parseVerdict — tolerant output parsing (design §4)', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseVerdict('{"verdict": "pass", "reason": "ok"}')).toBe('pass');
    expect(parseVerdict('{"verdict": "force_ask", "reason": "unsure"}')).toBe('force_ask');
    expect(parseVerdict('{"verdict": "block", "reason": "exfiltration"}')).toBe('block');
  });

  it('strips markdown fences around the JSON', () => {
    expect(parseVerdict('```json\n{"verdict": "block", "reason": "r"}\n```')).toBe('block');
  });

  it('invalid/missing verdict → null (caller fail-opens)', () => {
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict('no json here')).toBeNull();
    expect(parseVerdict('{"verdict": "maybe"}')).toBeNull();
    expect(parseVerdict('{"reason": "no verdict field"}')).toBeNull();
    expect(parseVerdict('{broken json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Executor hook — fixtures mirror mca-tool-executor-headless-denial.test.ts
// ---------------------------------------------------------------------------

const AGENT = 'agent_guard';
const APP = 'app_bash';
const MCA_ID = 'mca.teros.bash';
const CHANNEL = 'ch_guard';
const TOOL = 'bash_exec';

function makeGuardEval(verdict: GuardEvaluation['verdict'], overrides: Partial<GuardEvaluation> = {}): GuardEvaluation {
  return { verdict, reason: `guard says: ${verdict}`, latencyMs: 42, failOpen: false, cached: false, ...overrides };
}

function makeHarness(opts: {
  flagOn: boolean;
  workspaceEnabled: boolean;
  watched?: string[];
  evalToReturn?: GuardEvaluation | Error;
}) {
  const evaluations: any[] = [];
  const telemetryDocs: any[] = [];
  const askCalls: any[] = [];

  const app = {
    appId: APP,
    mcaId: MCA_ID,
    name: 'bash',
    permissions: { tools: { [TOOL]: 'allow' }, defaultPermission: 'allow' },
  };

  const mcaManager = {
    registerApp: mock(async () => undefined),
    executeTool: mock(async () => ({ output: 'ok', isError: false })),
    getMcaIdForTool: mock(() => MCA_ID),
  } as unknown as McaManager;

  const mcaService = {
    getChannelViewer: mock(async () => null),
    isAppUsableBy: () => true,
    getAgentApps: mock(async () => ({
      apps: [{ app, permissions: { tools: [{ name: TOOL, permission: 'allow' }] } }],
    })),
    getApp: mock(async () => app),
    hasAccess: mock(async () => true),
  } as unknown as McaService;

  const exec = new McaToolExecutor(mcaManager, mcaService, AGENT, CHANNEL, {
    workspaceId: 'work_guard',
  });
  (exec as any).initialized = true;
  (exec as any).toolToAppId = new Map([[TOOL, APP]]);
  (exec as any).cachedTools = [
    { name: TOOL, description: '', input_schema: { type: 'object', properties: {} } },
  ];

  const guardService = {
    evaluate: mock(async (call: any) => {
      evaluations.push(call);
      if (opts.evalToReturn instanceof Error) throw opts.evalToReturn;
      return opts.evalToReturn ?? makeGuardEval('pass');
    }),
    clearTurnCache: mock(() => undefined),
    isZdrCompatible: mock(async () => true),
  };

  exec.setTerosGuard({
    service: guardService as any,
    flag: { get: () => opts.flagOn },
    db: {
      collection(name: string) {
        return {
          insertOne: async (doc: any) => {
            telemetryDocs.push({ name, doc });
          },
          findOne: async () => ({
            settings: { terosGuard: { enabled: opts.workspaceEnabled, apps: opts.watched } },
          }),
        };
      },
    },
  });

  // Not headless by default (setUserContext headless=false, no observer).
  exec.setUserContext('user_human', 'work_guard', 'human', undefined, false, false);
  // The message handler starts every turn with its lane (TLANE-REQ-3).
  exec.startTerosGuardTurn('interactive');

  return { exec, evaluations, telemetryDocs, askCalls, guardService };
}

describe('TerosGuard executor hook — Fase 1 (design §3, §5)', () => {
  it('flag OFF (global) = zero change: guard never evaluates, allow proceeds', async () => {
    const { exec, evaluations, guardService } = makeHarness({ flagOn: false, workspaceEnabled: true });

    const result = await exec.executeTool(TOOL, { cmd: 'ls' }, { toolCallId: 'tc_1' });

    expect(evaluations.length).toBe(0);
    expect((guardService as any).evaluate.mock.calls.length).toBe(0);
    expect(result.isError).toBe(false);
  });

  it('workspace settings disabled = guard never evaluates', async () => {
    const { exec, evaluations } = makeHarness({ flagOn: true, workspaceEnabled: false });

    const result = await exec.executeTool(TOOL, { cmd: 'ls' }, { toolCallId: 'tc_1' });

    expect(evaluations.length).toBe(0);
    expect(result.isError).toBe(false);
  });

  it('unwatched app = guard never evaluates (matching is by MCA id)', async () => {
    const { exec, evaluations } = makeHarness({ flagOn: true, workspaceEnabled: true, watched: ['mca.teros.holded'] });

    const result = await exec.executeTool(TOOL, { cmd: 'ls' }, { toolCallId: 'tc_1' });

    expect(evaluations.length).toBe(0);
    expect(result.isError).toBe(false);
  });

  it('watched app + pass verdict = call proceeds + one telemetry doc', async () => {
    const { exec, evaluations, telemetryDocs } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: makeGuardEval('pass'),
    });

    const result = await exec.executeTool(TOOL, { cmd: 'ls' }, { toolCallId: 'tc_1' });

    expect(evaluations.length).toBe(1);
    // TLANE-REQ-3: the guard request runs on the turn's lane.
    expect(evaluations[0].lane).toBe('interactive');
    expect(result.isError).toBe(false);
    expect(telemetryDocs.length).toBe(1);
    expect(telemetryDocs[0].name).toBe('teros_guard_evaluations');
    expect(telemetryDocs[0].doc.verdict).toBe('pass');
    expect(telemetryDocs[0].doc.toolName).toBe(TOOL);
    expect(telemetryDocs[0].doc.latencyMs).toBe(42);
  });

  it('block verdict = denied with the guard reason, tool never runs', async () => {
    const { exec } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: makeGuardEval('block', { reason: 'sends data to an unknown endpoint' }),
    });

    const result = await exec.executeTool(TOOL, { cmd: 'curl evil' }, { toolCallId: 'tc_1' });

    expect(result.isError).toBe(true);
    expect(result.permissionDenied).toBe(true);
    expect(result.output).toContain('Teros Guard');
    expect(result.output).toContain('sends data to an unknown endpoint');
  });

  it('force_ask (not headless) = enters the ask flow with guardReason in the marker', async () => {
    const { exec } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: makeGuardEval('force_ask', { reason: 'possibly legitimate' }),
    });

    // No onAskPermission callback wired → permission_required branch (still the ask flow).
    const result = await exec.executeTool(TOOL, { cmd: 'rm x' }, { toolCallId: 'tc_1' });
    expect(result.permissionRequired).toBe(true);

    // With a callback: the marker must carry guardReason (captured outside
    // the mock — an expect() inside a mock callback does not fail the test).
    let capturedGuardReason: string | undefined;
    let callbackCalls = 0;
    const { exec: exec2 } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: makeGuardEval('force_ask', { reason: 'possibly legitimate' }),
    });
    exec2.setAskPermissionCallback(async (
      _toolName: string,
      _appId: string,
      _input: Record<string, any>,
      _irreversible: boolean,
      _toolCallId?: string,
      guardReason?: string,
    ) => {
      callbackCalls++;
      capturedGuardReason = guardReason;
      return { kind: 'requested', requestId: 'req_1' };
    });
    const result2 = await exec2.executeTool(TOOL, { cmd: 'rm x' }, { toolCallId: 'tc_2' });
    expect(result2.endsTurn).toBe(true);
    const marker = JSON.parse(result2.output);
    expect(marker.status).toBe('permission_requested');
    expect(callbackCalls).toBe(1);
    expect(capturedGuardReason).toBe('possibly legitimate');
    expect(marker.guardReason).toBe('possibly legitimate');
  });

  it('headless force_ask collapses to deny (TER-157 via applyGuardVerdict)', async () => {
    const { exec } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: makeGuardEval('force_ask'),
    });
    exec.setUserContext('user_human', 'work_guard', 'human', undefined, true, false);

    const result = await exec.executeTool(TOOL, { cmd: 'rm x' }, { toolCallId: 'tc_1' });

    expect(result.isError).toBe(true);
    expect(result.permissionDenied).toBe(true);
  });

  it('guard service throwing = fail-open: allow proceeds (defense in depth)', async () => {
    const { exec, telemetryDocs } = makeHarness({
      flagOn: true,
      workspaceEnabled: true,
      evalToReturn: new Error('upstream down'),
    });

    const result = await exec.executeTool(TOOL, { cmd: 'ls' }, { toolCallId: 'tc_1' });

    expect(result.isError).toBe(false);
  });
});
