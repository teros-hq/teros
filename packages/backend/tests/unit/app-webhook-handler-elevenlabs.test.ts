/**
 * Unit tests for AppWebhookHandler — ElevenLabs signature verification.
 *
 * ElevenLabs signs webhooks with HMAC-SHA256 over `${t}.${rawBody}` and sends
 * the result in `ElevenLabs-Signature: t={unix},v0={hex}`. These tests pin the
 * parsing, the signed-payload construction, and the replay window so a
 * regression in any of them fails loudly.
 *
 * Reference: https://elevenlabs.io/docs/eleven-api/resources/webhooks
 */

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import { AppWebhookHandler } from '../../src/handlers/app-webhook-handler';

const SECRET = 'whsec_elevenlabs_test';
const APP_ID = 'app_3249670f60abe67d';
const MCA_ID = 'mca.elevenlabs';

// Realistic post_call_transcription payload (shape from ElevenLabs docs)
const SAMPLE_PAYLOAD = {
  type: 'post_call_transcription',
  event_timestamp: 1729534477,
  data: {
    agent_id: 'agent_abc123',
    conversation_id: 'conv_xyz789',
    status: 'done',
    transcript: [
      { role: 'agent', message: 'Hola, ¿en qué puedo ayudarte?', time_in_call_secs: 0 },
      { role: 'user', message: 'Quería confirmar la cita del martes.', time_in_call_secs: 4 },
    ],
    metadata: {
      call_duration_secs: 47,
      termination_reason: 'user_hangup',
      cost: 312,
    },
    analysis: {
      transcript_summary: 'El usuario confirmó la cita del martes.',
      call_successful: 'success',
    },
  },
};

function signElevenLabs(rawBody: Buffer, secret: string, ts?: number): string {
  const t = ts ?? Math.floor(Date.now() / 1000);
  const signed = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), rawBody]);
  const v0 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${t},v0=${v0}`;
}

function fakeReq(body: string, headers: Record<string, string>, method = 'POST') {
  const req = Readable.from([Buffer.from(body, 'utf8')]) as Readable & {
    headers: Record<string, string>;
    method: string;
  };
  req.headers = headers;
  req.method = method;
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

function buildHandler(opts: { withSecret?: boolean } = {}) {
  const dispatched: Array<{ topic: string; payload: unknown }> = [];
  const mcaService = {
    getApp: async (appId: string) =>
      appId === APP_ID
        ? ({ appId, mcaId: MCA_ID, ownerId: 'work_test_workspace' } as never)
        : null,
  };
  const secretsManager = {
    mca: (mcaId: string) =>
      mcaId === MCA_ID && opts.withSecret !== false
        ? ({ WEBHOOK_SECRET: SECRET } as never)
        : undefined,
  };
  const mcaEventSubscriptionService = {
    dispatch: async (evt: { topic: string; payload: unknown }) => {
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
  // The handler dispatches via setImmediate — let the microtask queue drain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('AppWebhookHandler — ElevenLabs-Signature', () => {
  it('accepts a correctly signed post_call_transcription payload', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const sig = signElevenLabs(Buffer.from(body, 'utf8'), SECRET);
    const req = fakeReq(body, { 'elevenlabs-signature': sig });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(200);
    const parsed = JSON.parse(out.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.topic).toBe('elevenlabs.post_call_transcription');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].topic).toBe('elevenlabs.post_call_transcription');
    const p = dispatched[0].payload as typeof SAMPLE_PAYLOAD & {
      workspaceId: string;
      _webhook: { appId: string; mcaId: string };
    };
    expect(p.data.conversation_id).toBe('conv_xyz789');
    expect(p.data.analysis.transcript_summary).toContain('martes');
    expect(p.workspaceId).toBe('work_test_workspace');
    expect(p._webhook.appId).toBe(APP_ID);
    expect(p._webhook.mcaId).toBe(MCA_ID);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const sig = signElevenLabs(Buffer.from(body, 'utf8'), 'whsec_WRONG');
    const req = fakeReq(body, { 'elevenlabs-signature': sig });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error).toBe('Invalid signature');
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a tampered body (signature does not match content)', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const sig = signElevenLabs(Buffer.from(body, 'utf8'), SECRET);
    const tampered = body.replace('done', 'failed');
    const req = fakeReq(tampered, { 'elevenlabs-signature': sig });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
    const sig = signElevenLabs(Buffer.from(body, 'utf8'), SECRET, staleTs);
    const req = fakeReq(body, { 'elevenlabs-signature': sig });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a malformed header (missing v0)', async () => {
    const { handler, dispatched } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = fakeReq(body, { 'elevenlabs-signature': 't=1729534477' });
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);
    await flush();

    expect(out.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('falls through to the generic HMAC path when no ElevenLabs header is present', async () => {
    const { handler } = buildHandler();
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = fakeReq(body, {}); // no signature headers at all
    const { res, out } = fakeRes();

    await handler.handleRoute(req, res, `/webhooks/apps/${APP_ID}`);

    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error).toBe('Missing signature header');
  });
});
