/**
 * E2E de ingesta HTTP — POST /api/v1/webhooks/:token.
 *
 * Levanta un servidor HTTP REAL con `createAutomateRoutes` (el mismo wiring
 * que http-server.ts) contra MongoDB real y ejecuta el flujo completo que
 * describe el runbook: curl → 202 → tarea creada → llamada registrada →
 * stats actualizadas. Cubre además los códigos de error (404/409/400) y el
 * upsert por discriminator.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import { type Db, MongoClient } from 'mongodb'
import { createAutomateRoutes } from '../../src/routes/automate-routes'
import { AutomateModel } from '../../src/models/automate'
import { AutomateRunner } from '../../src/services/automate-runner'
import { AUTOMATE_QUOTA_REASON } from '../../src/services/automate-quota'
import { BoardService } from '../../src/services/board-service'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_automate_ingestion_test_${Date.now()}`

const USER_ALICE = 'user_ingestion_test'
const WORKSPACE_A = 'work_ingestion_test'
const PROJECT_A = 'proj_ingestion_test'
const BOARD_A = 'board_ingestion_test'
const AGENT_A = 'agent_ingestion_test'

let client: MongoClient
let db: Db
let model: AutomateModel
let server: http.Server
let baseUrl: string
let runner: AutomateRunner

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)

  await db.collection('workspaces').insertOne({
    workspaceId: WORKSPACE_A,
    name: 'Ingestion WS',
    ownerId: USER_ALICE,
    status: 'active',
    members: [{ userId: USER_ALICE, role: 'owner' }],
  })
  await db.collection('projects').insertOne({
    projectId: PROJECT_A,
    workspaceId: WORKSPACE_A,
    name: 'Ingestion Project',
    status: 'active',
    boardId: BOARD_A,
  })
  await db.collection('boards').insertOne({
    boardId: BOARD_A,
    projectId: PROJECT_A,
    columns: [
      { columnId: 'col_backlog', slug: 'backlog', name: 'Backlog', position: 0 },
      { columnId: 'col_todo', slug: 'todo', name: 'To Do', position: 1 },
      { columnId: 'col_done', slug: 'done', name: 'Done', position: 2 },
    ],
  })
  await db.collection('agents').insertOne({
    agentId: AGENT_A,
    name: 'Ingestion Agent',
    status: 'active',
    workspaceId: WORKSPACE_A,
  })

  model = new AutomateModel(db)
  await model.ensureIndexes()

  const boardService = new BoardService(db)
  runner = new AutomateRunner({
    db,
    model,
    boardService,
    handleScheduledEvent: async () => ({ success: true }),
    actionBridgeManager: null,
  })
  const handleRoutes = createAutomateRoutes({ model, runner, db })

  server = http.createServer((req, res) => {
    void handleRoutes(req, res, req.url ?? '/').then((handled) => {
      // En producción http-server.ts seguiría con el resto de handlers; aquí
      // un no-manejado simplemente responde 404 vacío.
      if (!handled && !res.writableEnded) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.dropDatabase()
  await client.close()
})

async function createEnabledWebhook(name: string, token: string) {
  return model.createStarter({
    name,
    createdBy: USER_ALICE,
    workspaceId: WORKSPACE_A,
    trigger: {
      type: 'webhook',
      tokenHash: sha256(token),
      callCount: 0,
    },
    action: {
      type: 'create-task',
      projectId: PROJECT_A,
      agentId: AGENT_A,
      targetColumnId: 'col_todo',
      titleTemplate: '{{title || "Webhook"}}',
      instructionsTemplate: `Automate trigger: ${name}\n\nPayload:\n{{payload}}`,
    },
  })
}

describe('POST /api/v1/webhooks/:token (E2E ingesta)', () => {
  it('token válido → 202, crea tarea con payload e instructions y registra la llamada', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    const starter = await createEnabledWebhook('E2E webhook', token)

    const { status, json } = await post(`/api/v1/webhooks/${token}`, {
      title: 'Incidencia desde GitHub',
      discriminator: 'gh-123',
      data: { repo: 'teros', issue: 42 },
    })

    expect(status).toBe(202)
    expect(json.success).toBe(true)
    expect(json.starterId).toBe(starter.starterId)
    expect(json.createdTask).toBe(true)
    expect(json.taskId).toBeDefined()

    // La tarea existe, en la columna correcta, con instructions (requerido por dev)
    const task = await db.collection('tasks').findOne({ taskId: json.taskId })
    expect(task).not.toBeNull()
    expect(task!.title).toBe('Incidencia desde GitHub')
    expect(task!.columnId).toBe('col_todo')
    expect(task!.instructions).toContain('E2E webhook')
    expect(task!.instructions).toContain('gh-123')
    expect(task!.tags).toContain('automate:webhook')

    // La llamada queda registrada (modal de llamadas) y stats actualizadas
    const call = await db.collection('automate_webhook_calls').findOne({ starterId: starter.starterId })
    expect(call).not.toBeNull()
    expect(call!.taskId).toBe(json.taskId)
    expect(call!.discriminator).toBe('gh-123')

    const updated = await model.getStarterById(starter.starterId)
    expect(updated!.trigger).toMatchObject({ callCount: 1 })
    expect((updated!.trigger as any).lastCallAt).toBeDefined()
  })

  it('discriminator repetido → añade nota a la tarea existente (createdTask: false)', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    await createEnabledWebhook('E2E idempotente', token)

    const first = await post(`/api/v1/webhooks/${token}`, { discriminator: 'disc-e2e', n: 1 })
    expect(first.status).toBe(202)
    expect(first.json.createdTask).toBe(true)

    const second = await post(`/api/v1/webhooks/${token}`, { discriminator: 'disc-e2e', n: 2 })
    expect(second.status).toBe(202)
    expect(second.json.createdTask).toBe(false)
    expect(second.json.taskId).toBe(first.json.taskId)

    const task = await db.collection('tasks').findOne({ taskId: first.json.taskId })
    const notes = (task?.progressNotes ?? []) as Array<{ text: string }>
    expect(notes.some((n) => n.text.includes('Webhook payload received'))).toBe(true)
  })

  it('token desconocido → 404', async () => {
    const { status, json } = await post(`/api/v1/webhooks/${'a'.repeat(64)}`, { x: 1 })
    expect(status).toBe(404)
    expect(json.error).toBe('NOT_FOUND')
  })

  it('starter desactivado → 409 DISABLED', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    const starter = await createEnabledWebhook('E2E desactivado', token)
    await model.setStarterEnabled(starter.starterId, false)

    const { status, json } = await post(`/api/v1/webhooks/${token}`, { x: 1 })
    expect(status).toBe(409)
    expect(json.error).toBe('DISABLED')
  })

  it('JSON inválido → 400', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    await createEnabledWebhook('E2E bad json', token)

    const { status, json } = await post(`/api/v1/webhooks/${token}`, '{not-json')
    expect(status).toBe(400)
    expect(json.error).toBe('BAD_REQUEST')
  })

  it('GET no coincide (solo POST) → la ruta devuelve false y el servidor responde 404', async () => {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/whatever`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/webhooks/:token — cuota diaria agotada', () => {
  it('responde 429 QUOTA_EXCEEDED con el motivo, no crea tarea y registra la llamada como rechazada', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    const starter = await createEnabledWebhook('Webhook sin cuota', token)
    runner.setCanExecute(async () => ({
      allowed: false,
      countsAsFailure: false,
      reason: `${AUTOMATE_QUOTA_REASON}: 5/5 Automate executions used today (Seed plan, resets at 00:00 UTC).`,
    }))
    try {
      const { status, json } = await post(`/api/v1/webhooks/${token}`, { title: 'x' })
      expect(status).toBe(429)
      expect(json.error).toBe('QUOTA_EXCEEDED')
      expect(json.message).toStartWith(AUTOMATE_QUOTA_REASON)
      expect(json.starterId).toBe(starter.starterId)
      const exec = await db.collection('automate_executions').findOne({ starterId: starter.starterId })
      expect(exec!.refused).toBe(true)
      expect(exec!.ok).toBe(false)
      const s = await model.getStarterById(starter.starterId)
      expect(s!.consecutiveFailures ?? 0).toBe(0)
    } finally {
      runner.setCanExecute(undefined)
    }
  })

  it('un rechazo de billing sigue siendo 500 EXECUTION_ERROR', async () => {
    const token = crypto.randomBytes(32).toString('hex')
    await createEnabledWebhook('Webhook sin horas', token)
    runner.setCanExecute(async () => ({ allowed: false, reason: 'billing-hours_exhausted' }))
    try {
      const { status, json } = await post(`/api/v1/webhooks/${token}`, { title: 'x' })
      expect(status).toBe(500)
      expect(json.error).toBe('EXECUTION_ERROR')
    } finally {
      runner.setCanExecute(undefined)
    }
  })
})
