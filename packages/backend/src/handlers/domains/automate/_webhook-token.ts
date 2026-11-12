/**
 * Webhook token generation — the raw token goes into the URL shown once to
 * the user; only its SHA-256 is stored on the starter.
 */

import crypto from 'node:crypto'
import { config } from '../../../config'

export interface WebhookToken {
  hash: string
  url: string
}

export function newWebhookToken(): WebhookToken {
  const token = crypto.randomBytes(32).toString('hex')
  return {
    hash: crypto.createHash('sha256').update(token).digest('hex'),
    url: `${config.share.baseUrl}/api/v1/webhooks/${token}`,
  }
}
