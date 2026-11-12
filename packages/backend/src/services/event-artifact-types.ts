/**
 * Event artifact types.
 *
 * Every topic an app declares in its manifest `events[]` becomes a global
 * artifact type (`artifacts` collection, docs/specs/tasks/artifacts.md) whose
 * form-first schema is derived from the declared payload. The event catalog
 * and the artifact catalog are then the same document: a task created by an
 * Automate event starter carries `input = { schemaId: evt_<topic>, schema, data }`.
 */
import type { Db } from 'mongodb'
import { getArtifactsCollection } from '@teros/workflows/models'
import type { Artifact, ArtifactProperty, ArtifactSchema, FieldType } from '@teros/workflows/models'

const EVENT_ARTIFACT_COLOR = '#F59E0B'
const EVENT_ARTIFACT_ICON = '⚡'

/** Deterministic artifact id of an event topic: `art_evt_telegram_message_received`. */
export function eventArtifactId(topic: string): string {
  return `art_evt_${topic.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}

/**
 * Map a declared payload field type ("string", "number", "boolean",
 * "ISO date", "user|group|channel", "number[]", "string|null"…) to a
 * form-first artifact property.
 */
export function payloadFieldToProperty(name: string, declared: string): ArtifactProperty {
  const raw = String(declared ?? 'string').trim()
  const nullable = /\bnull\b/i.test(raw) || raw.endsWith('?')
  const base = raw.replace(/\s*\|\s*null\b/gi, '').replace(/\?$/, '').trim()
  const lower = base.toLowerCase()
  let type: FieldType = 'text'
  let options: ArtifactProperty['options'] | undefined
  if (lower === 'number' || lower === 'integer' || lower === 'float') type = 'number'
  else if (lower === 'boolean' || lower === 'bool') type = 'checkbox'
  else if (lower.includes('iso date') || lower === 'datetime' || lower === 'date-time' || lower === 'timestamp') type = 'datetime'
  else if (lower === 'date') type = 'date'
  else if (lower.endsWith('[]') || lower.startsWith('array') || lower === 'object' || lower === 'json') type = 'textarea'
  else if (base.includes('|') && !/[\s()]/.test(base)) {
    type = 'select'
    options = base.split('|').map((v) => v.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
  }
  return {
    name,
    type,
    required: !nullable,
    ...(options ? { options } : {}),
    description: raw,
    label: name,
  }
}

export function eventArtifactSchema(topic: string, payload: Record<string, string> | undefined): ArtifactSchema {
  const properties: Record<string, ArtifactProperty> = {}
  for (const [name, declared] of Object.entries(payload ?? {})) properties[name] = payloadFieldToProperty(name, declared)
  return { name: topic, title: topic, type: 'object', properties }
}

function buildArtifact(topic: string, description: string | undefined, payload: Record<string, string> | undefined, now: Date): Artifact {
  return {
    artifactId: eventArtifactId(topic),
    source: 'global',
    name: topic,
    title: topic,
    description: description ?? `Payload of the ${topic} event`,
    color: EVENT_ARTIFACT_COLOR,
    icon: EVENT_ARTIFACT_ICON,
    schema: eventArtifactSchema(topic, payload),
    createdAt: now,
    updatedAt: now,
  } as Artifact
}

interface CatalogEvent {
  topic: string
  description?: string
  payload?: Record<string, string>
}

/** Upsert one artifact type per declared event topic across the whole catalog. Returns how many were written. */
export async function syncEventArtifactTypes(db: Db): Promise<number> {
  const catalog = await db
    .collection<{ mcaId: string; events?: CatalogEvent[] }>('mca_catalog')
    .find({ events: { $exists: true, $ne: [] } }, { projection: { mcaId: 1, events: 1 } })
    .toArray()
  const artifacts = getArtifactsCollection(db)
  const now = new Date()
  let written = 0
  for (const entry of catalog) {
    for (const ev of entry.events ?? []) {
      if (!ev?.topic) continue
      const artifact = buildArtifact(ev.topic, ev.description, ev.payload, now)
      const { createdAt, ...rest } = artifact as Artifact & { createdAt: Date }
      await artifacts.updateOne(
        { artifactId: artifact.artifactId },
        { $set: rest, $setOnInsert: { createdAt } },
        { upsert: true },
      )
      written += 1
    }
  }
  return written
}

/**
 * The artifact type of an event topic: from the `artifacts` collection, or
 * built on the fly from the catalog when the sync has not run yet. Null when
 * no installed app declares the topic.
 */
export async function resolveEventArtifact(db: Db, topic: string): Promise<{ schemaId: string; schema: ArtifactSchema } | null> {
  const artifactId = eventArtifactId(topic)
  const existing = await getArtifactsCollection(db).findOne({ artifactId })
  if (existing) return { schemaId: artifactId, schema: existing.schema }
  const entry = await db
    .collection<{ mcaId: string; events?: CatalogEvent[] }>('mca_catalog')
    .findOne({ 'events.topic': topic }, { projection: { events: 1 } })
  const ev = entry?.events?.find((e) => e.topic === topic)
  if (!ev) return null
  const artifact = buildArtifact(topic, ev.description, ev.payload, new Date())
  await getArtifactsCollection(db).updateOne({ artifactId }, { $setOnInsert: artifact }, { upsert: true })
  return { schemaId: artifactId, schema: artifact.schema }
}
