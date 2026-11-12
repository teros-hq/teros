/**
 * Automate HTTP Routes
 *
 * Public webhook ingestion endpoint for external starters.
 *
 *   POST /api/v1/webhooks/:token
 *
 * The URL token is the starter's secret. On a valid request we look up the
 * starter by SHA-256 hash of the token, validate it is enabled and of type
 * `webhook`, and execute the starter's ACTION through the AutomateRunner
 * (create-task, channel-event or start-flow — whatever the starter defines).
 *
 * The payload → execution step (discriminator dedupe, audit log, stats) is
 * `ingestWebhookPayload`, shared with `automate.test-webhook`.
 *
 * Auth: none (the token is the secret).
 */

import crypto from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { Db } from 'mongodb'
import type { AutomateModel } from '../models/automate'
import type { AutomateRunner } from '../services/automate-runner'
import { AUTOMATE_QUOTA_REASON } from '../services/automate-quota'
import { ingestWebhookPayload } from '../services/automate-webhook-ingest'

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString()
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// ============================================================================
// ROUTE FACTORY
// ============================================================================

export interface AutomateRoutesConfig {
  model: AutomateModel
  runner: AutomateRunner | null
  db: Db
}

const RE_WEBHOOK = /^\/api\/v1\/webhooks\/([^/]+)$/

export function createAutomateRoutes(cfg: AutomateRoutesConfig) {
  const { model, runner } = cfg

  return async function handleAutomateRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const basePath = url.indexOf('?') === -1 ? url : url.slice(0, url.indexOf('?'))
    const method = req.method ?? ''

    const match = RE_WEBHOOK.exec(basePath)
    if (!match || method !== 'POST') {
      return false
    }

    const token = match[1]

    let body: any
    try {
      body = await readBody(req)
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Invalid JSON body' })
      return true
    }

    const tokenHash = sha256(token)
    const starter = await model.getStarterByTokenHash(tokenHash)
    if (!starter) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: 'Unknown webhook token' })
      return true
    }

    if (!starter.enabled) {
      sendJson(res, 409, { error: 'DISABLED', message: 'Starter is disabled' })
      return true
    }

    if (starter.type !== 'webhook') {
      sendJson(res, 409, { error: 'INVALID_TYPE', message: 'Starter is not a webhook' })
      return true
    }

    if (!runner) {
      sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'AutomateRunner not available' })
      return true
    }

    const payload = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
    const result = await ingestWebhookPayload(model, runner, starter, payload, { ip: extractIp(req) })

    if (!result.ok) {
      // The creator's daily Automate budget is spent: nothing ran, and the
      // caller should back off until the quota resets (00:00 UTC), not retry.
      if (result.refused && result.error?.startsWith(AUTOMATE_QUOTA_REASON)) {
        sendJson(res, 429, {
          error: 'QUOTA_EXCEEDED',
          message: result.error,
          starterId: starter.starterId,
        })
        return true
      }
      sendJson(res, 500, {
        error: 'EXECUTION_ERROR',
        message: result.error ?? 'Action execution failed',
        starterId: starter.starterId,
      })
      return true
    }

    sendJson(res, 202, {
      success: true,
      starterId: starter.starterId,
      actionType: result.actionType,
      taskId: result.taskId,
      executionId: result.executionId,
      createdTask: !!result.taskId && !result.updatedExisting,
    })
    return true
  }
}

function extractIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? undefined
}
