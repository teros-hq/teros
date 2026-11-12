/**
 * AppWebhookHandler — flatten del payload post_call (VOICE-NOTIFY-1 / P2).
 *
 * El handler debe proyectar los campos anidados data.* a aliases top-level
 * ANTES del dispatch al bus, para que las suscripciones (rulesMatch) y los
 * filtros Automate puedan filtrar por conversationId. El shape anidado se
 * preserva (compat con plantillas {{data.*}}). Los 6 tests de firma del
 * archivo hermano (app-webhook-handler-elevenlabs.test.ts) siguen verdes.
 */

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import { AppWebhookHandler } from '../../src/handlers/app-webhook-handler';

const SECRET = 'whsec_elevenlabs_test';
const APP_ID = 'app_3249670f60abe67d';
const MCA_ID = 'mca.elevenlabs';

const SAMPLE_PAYLOAD = {
  type: 'post_call_transcription',
  event_timestamp: 1729534477,
  data: {
    agent_id: 'agent_abc123',
    conversation_id: 'conv_xyz789',
    status: 'done',
    analysis: {
      transcript_summary: 'El usuario confirmó la cita del martes.',
      call_successful: 'success',
    },
    metadata: {
      call_duration_secs: 47,
      termination_reason: 'user_hangup',
      cost: 312,
    },
  },
};

function signElevenLabs(rawBody: Buffer, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const signed = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), rawBody]);
  const v0 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${t},v0=${v0}`;
}

function fakeReq(body: string, headers: Record<string, string>) {
  const req = Readable.from([Buffer.from(body, 'utf8')]) as Readable & {
    headers: Record<string, string>;
    method: string;
  };
  req.headers = headers;
  req.method = 'POST';
  return req as never;
}

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead: (status: number) => {
      out.status = status;
    },
    end: (body?: string) => {
      out.body = body ?? '';
    },
  };
  return { res: res as never, out };
}

function buildHandler() {
  const dispatched: Array<{ topic: string; payload: any }> = [];
  const mcaService = {
    getApp: async (appId: string) =>
      appId === APP_ID
        ? ({ appId, mcaId: MCA_ID, ownerId: 'work_test_workspace' } as never)
        : null,
  };
  const secretsManager = {
    mca: (mcaId: string) => (mcaId === MCA_ID ? ({ WEBHOOK_SECRET: SECRET } as never) : undefined),
  };
  const mcaEventSubscriptionService = {
    dispatch: async (evt: { topic: string; payload: any }) => {
      dispatched.push(evt);
    },
  };
  const handler = new AppWebhookHandler(
    mcaService as never,
    secretsManager as never,
    mcaEventSubscriptionService as never,
  );
  return { handler, dispatched };
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('AppWebhookHandler — post_call payload flatten at dispatch', () => {
  it('dispatches with flat aliases AND the nested data.* shape', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = fakeReq(body, { 'elevenlabs-signature': signElevenLabs(Buffer.from(body, 'utf8'), SECRET) });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].topic).toBe('elevenlabs.post_call_transcription');

    const p = dispatched[0].payload;
    // Flat aliases (for subscription rules / Automate filters)
    expect(p.conversationId).toBe('conv_xyz789');
    expect(p.transcriptSummary).toBe('El usuario confirmó la cita del martes.');
    expect(p.callSuccessful).toBe('success');
    expect(p.durationSecs).toBe(47);
    expect(p.terminationReason).toBe('user_hangup');
    expect(p.cost).toBe(312);
    // Nested shape preserved (for {{data.*}} templates)
    expect(p.data.conversation_id).toBe('conv_xyz789');
    expect(p.data.analysis.transcript_summary).toBe('El usuario confirmó la cita del martes.');
  });

  it('does NOT flatten other event types of the same MCA', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify({ type: 'call_initiation_failure', data: { conversation_id: 'conv_x' } });
    const req = fakeReq(body, { 'elevenlabs-signature': signElevenLabs(Buffer.from(body, 'utf8'), SECRET) });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].topic).toBe('elevenlabs.call_initiation_failure');
    expect(dispatched[0].payload.conversationId).toBeUndefined();
  });

  it('does NOT flatten the same event type from ANOTHER MCA', async () => {
    const OTHER_APP = 'app_other';
    const { handler, dispatched } = buildHandler();
    // Rebuild with a second app resolving to a different mcaId
    const mcaService = {
      getApp: async (appId: string) =>
        appId === OTHER_APP
          ? ({ appId, mcaId: 'mca.other', ownerId: 'work_test_workspace' } as never)
          : null,
    };
    const secretsManager = { mca: () => ({ WEBHOOK_SECRET: SECRET } as never) };
    const mcaEventSubscriptionService = {
      dispatch: async (evt: { topic: string; payload: any }) => {
        dispatched.push(evt);
      },
    };
    const otherHandler = new AppWebhookHandler(
      mcaService as never,
      secretsManager as never,
      mcaEventSubscriptionService as never,
    );

    const body = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'conv_y' } });
    const req = fakeReq(body, { 'x-webhook-signature': `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}` });
    const { res, out } = fakeRes();

    await otherHandler.handleRoute(req, res, `/webhooks/apps/${OTHER_APP}`);
    await flush();

    expect(out.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].topic).toBe('other.post_call_transcription');
    expect(dispatched[0].payload.conversationId).toBeUndefined();
  });
});
