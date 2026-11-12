/**
 * Sleeping terminal sessions, in Mongo (PtyManager's SleepStore).
 *
 * A session whose terminal host was hibernated lives here until it is woken
 * (then the document goes) or closed. One document per terminalId, scoped to
 * the backend stack that saved it (two stacks sharing a Mongo never wake each
 * other's sessions). The scrollback is workspace data: it carries workspaceId
 * and goes with the workspace (deletion-service).
 */

import type { Db } from "mongodb"
import { COLLECTIONS, collection } from "../../db"
import type { SleepRecord, SleepStore } from "../pty-manager"

export class TerminalSleepStore implements SleepStore {
  constructor(private readonly db: Db) {}

  private get docs() {
    return collection<SleepRecord>(this.db, COLLECTIONS.terminalSleepingSessions)
  }

  async load(stackId: string): Promise<SleepRecord[]> {
    const docs = await this.docs.find({ stackId }, { projection: { _id: 0 } }).toArray()
    return docs as SleepRecord[]
  }

  async save(record: SleepRecord): Promise<void> {
    await this.docs.replaceOne({ terminalId: record.terminalId }, record, { upsert: true })
  }

  async remove(terminalId: string): Promise<void> {
    await this.docs.deleteOne({ terminalId })
  }

  async rename(terminalId: string, title: string): Promise<void> {
    await this.docs.updateOne({ terminalId }, { $set: { title } })
  }

  async setLease(terminalId: string, lease: string): Promise<void> {
    await this.docs.updateOne({ terminalId }, { $set: { lease } })
  }
}
