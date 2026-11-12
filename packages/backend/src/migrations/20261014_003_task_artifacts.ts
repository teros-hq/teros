/**
 * Migration: task artifacts (docs/specs/tasks/artifacts.md).
 *
 * The task owns its input and output artifacts. The workflow-era fields move:
 *   - workflowInputData                  → input.data  (+ input.schemaId from workflowInputGate.schemaId)
 *   - workflowOutputData                 → output.data (+ output.schemaId from workflowOutputGate.schemaId)
 *   - workflowOutputGate.resolvedSchema  → output.schema (and is removed from the gate)
 * Gates (workflowInputGate / workflowOutputGate) and the execution/node ids stay
 * as the engine's routing metadata.
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

interface LegacyTask {
  taskId: string
  workflowInputGate?: { schemaId?: string | null; resolvedSchema?: unknown; [k: string]: unknown }
  workflowOutputGate?: { schemaId?: string | null; resolvedSchema?: unknown; [k: string]: unknown }
  workflowInputData?: unknown
  workflowOutputData?: unknown
  input?: unknown
  output?: unknown
}

const migration: Migration = {
  description: 'Task artifacts: move workflowInputData / workflowOutputData / resolvedSchema into task.input / task.output',

  async up(db: Db): Promise<void> {
    const tasks = db.collection<LegacyTask>('tasks')
    const cursor = tasks.find({
      $or: [
        { workflowInputData: { $exists: true } },
        { workflowOutputData: { $exists: true } },
        { 'workflowOutputGate.resolvedSchema': { $exists: true } },
        { 'workflowInputGate.resolvedSchema': { $exists: true } },
        { workflowOutputGate: { $exists: true }, output: { $exists: false } },
        { workflowInputGate: { $exists: true }, input: { $exists: false } },
      ],
    })

    let migrated = 0
    for await (const task of cursor) {
      const $set: Record<string, unknown> = {}
      const $unset: Record<string, ''> = {}

      if (task.workflowInputGate && task.input === undefined) {
        $set.input = {
          schemaId: task.workflowInputGate.schemaId ?? null,
          ...(task.workflowInputGate.resolvedSchema ? { schema: task.workflowInputGate.resolvedSchema } : {}),
          ...(task.workflowInputData !== undefined ? { data: task.workflowInputData } : {}),
        }
      } else if (task.workflowInputData !== undefined && task.input === undefined) {
        $set.input = { schemaId: null, data: task.workflowInputData }
      }
      if (task.workflowOutputGate && task.output === undefined) {
        $set.output = {
          schemaId: task.workflowOutputGate.schemaId ?? null,
          ...(task.workflowOutputGate.resolvedSchema ? { schema: task.workflowOutputGate.resolvedSchema } : {}),
          ...(task.workflowOutputData !== undefined && task.workflowOutputData !== null ? { data: task.workflowOutputData } : {}),
        }
      } else if (task.workflowOutputData !== undefined && task.workflowOutputData !== null && task.output === undefined) {
        $set.output = { schemaId: null, data: task.workflowOutputData }
      }

      if ('workflowInputData' in task) $unset.workflowInputData = ''
      if ('workflowOutputData' in task) $unset.workflowOutputData = ''
      if (task.workflowOutputGate?.resolvedSchema !== undefined) $unset['workflowOutputGate.resolvedSchema'] = ''
      if (task.workflowInputGate?.resolvedSchema !== undefined) $unset['workflowInputGate.resolvedSchema'] = ''

      if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) continue
      await tasks.updateOne(
        { taskId: task.taskId },
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
      )
      migrated += 1
    }
    console.log(`[Migration 20261014_003] task artifacts: ${migrated} tasks migrated`)
  },
}

export default migration
