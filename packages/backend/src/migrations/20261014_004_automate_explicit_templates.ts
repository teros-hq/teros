/**
 * Migration: Automate templates become explicit and required
 * (docs/specs/tasks/artifacts.md §4 — no fallbacks).
 *
 * Until now a create-task action without templates fell back to
 * payload.title → starter name for the title and to a JSON dump for the
 * instructions, and a channel-event without a message used
 * "Automate trigger fired: <name>". Those implicit behaviours are written
 * into the starters as real templates so nothing changes for them and the
 * runner can refuse empty templates from now on.
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

interface StarterDoc {
  starterId: string
  name: string
  type: string
  action: { type: string; titleTemplate?: string; instructionsTemplate?: string; eventTemplate?: string }
}

/** Starter names may contain braces; a literal must not be parsed as a placeholder. */
function literal(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
}

const migration: Migration = {
  description: 'Automate: make the implicit title / instructions / message fallbacks explicit templates on existing starters',

  async up(db: Db): Promise<void> {
    const starters = db.collection<StarterDoc>('automate_starters')
    let updated = 0
    for await (const s of starters.find({ 'action.type': { $in: ['create-task', 'channel-event'] } })) {
      const $set: Record<string, string> = {}
      if (s.action.type === 'create-task') {
        if (!s.action.titleTemplate?.trim()) {
          // Webhooks relied on payload.title; everything else on the starter name.
          $set['action.titleTemplate'] = s.type === 'webhook' ? `{{title || "${literal(s.name).replace(/"/g, "'")}"}}` : literal(s.name)
        }
        if (!s.action.instructionsTemplate?.trim()) {
          $set['action.instructionsTemplate'] = `Automate trigger: ${literal(s.name)}\n\nPayload:\n{{payload}}`
        }
      } else if (!s.action.eventTemplate?.trim()) {
        $set['action.eventTemplate'] = `Automate trigger fired: ${literal(s.name)}`
      }
      if (Object.keys($set).length === 0) continue
      await starters.updateOne({ starterId: s.starterId }, { $set })
      updated += 1
    }
    console.log(`[Migration 20261014_004] explicit templates written on ${updated} starters`)
  },
}

export default migration
