/**
 * UiStateManager — live, in-memory mirror of what each connected client is
 * seeing (spec 20261022_ui-state-mca.md, REQ-2).
 *
 * Presence-style service (same shape as PtyManager's presence parts): a Map
 * keyed (userId, workspaceId, deviceId) holding the latest UiStateReport plus
 * the WS sessions that reported it (targeted delivery), with a TTL sweep that
 * evicts entries 5 min after they lose their last reporting session. No DB —
 * `desktop-state` stays the durability mechanism; a backend restart loses the
 * model and clients re-report on reconnect (REQ-1).
 *
 * Online = the device has at least one live reporting session, or lost them
 * less than UI_OFFLINE_GRACE_MS ago (reconnect blips). Reports are
 * change-driven, not heartbeats — a quiet desktop keeps its sessions and
 * stays online; presence is driven by WS session lifecycle (dropSession is
 * called from the WS close path), not by report recency.
 *
 * Active device (REQ-2) = the online device with the most recent lastSeen;
 * ties are won by the latest report (a monotonic seq).
 */

import type { UiStateReport } from "@teros/shared"
import {
  UI_MAX_DESKTOPS,
  UI_MAX_DEVICES_PER_USER,
  UI_MAX_REPORT_BYTES,
  UI_MAX_WINDOW_TYPES,
  UI_MAX_WINDOWS,
} from "@teros/shared"

/** A device goes offline this long after losing its last reporting session (REQ-2: grace ≤ 30 s). */
export const UI_OFFLINE_GRACE_MS = 30_000
/** A sessionless device is evicted after this long (REQ-2: 5 min). */
export const UI_EVICT_AFTER_MS = 5 * 60_000
/** How often the sweep evicts stale entries (cheap: date math only). */
const SWEEP_INTERVAL_MS = 30_000

const MAX_ID_LEN = 200
const MAX_LABEL_LEN = 200
const MAX_TITLE_LEN = 500
/** The client's user agent (diagnostics). Real UAs run ~300 chars; 512 leaves
 * headroom while bounding the per-device overhead. */
const MAX_UA_LEN = 512
const MAX_TYPE_LEN = 64
const MAX_PROPS_KEYS = 64
const MAX_TABS = 45
const MAX_LAYOUT_NODES = 128
const MAX_LAYOUT_DEPTH = 12

/** One device's live entry in the mirror. */
export interface UiDeviceEntry {
  userId: string
  workspaceId: string
  deviceId: string
  /** Latest label reported (kept when a later report omits it). */
  deviceLabel?: string
  /** Latest user agent reported (kept when a later report omits it). */
  userAgent?: string
  /** Latest accepted report. */
  report: UiStateReport
  /** Epoch ms of the latest accepted report. */
  lastSeen: number
  /** Monotonic report counter — active-device tie-break (latest report wins). */
  seq: number
  /** WS sessions that reported this device (targeted delivery). */
  sessionIds: Set<string>
  /** Epoch ms when the device lost its last reporting session; null while connected. */
  offlineSince: number | null
}

export type UiReportValidation =
  | { ok: true; report: UiStateReport }
  | { ok: false; reason: string }

export interface UiStateManagerOptions {
  /** Injectable clock — deterministic in tests (TER-563 pattern). */
  now?: () => number
  /** 0 disables the periodic sweep (tests sweep manually). */
  sweepIntervalMs?: number
}

// ── Validation helpers ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** A non-empty string within `max`, or null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null
  return v
}

/** Layout-tree budget: bounds a malicious report to a small tree. */
interface NodeBudget {
  count: number
}

function validateNode(node: unknown, depth: number, budget: NodeBudget): string | null {
  if (depth > MAX_LAYOUT_DEPTH) return "layout tree too deep"
  if (++budget.count > MAX_LAYOUT_NODES) return "layout tree too large"
  if (!isPlainObject(node)) return "node must be an object"
  if (node.kind === "split") {
    if (node.direction !== "horizontal" && node.direction !== "vertical") {
      return "split.direction must be 'horizontal' or 'vertical'"
    }
    if (node.ratio !== undefined && node.ratio !== null) {
      if (
        typeof node.ratio !== "number" ||
        !Number.isFinite(node.ratio) ||
        node.ratio < 0 ||
        node.ratio > 1
      ) {
        return "split.ratio must be a number in 0..1"
      }
    }
    if (!Array.isArray(node.children) || node.children.length !== 2) {
      return "split.children must be an array of exactly 2 nodes"
    }
    for (let i = 0; i < 2; i++) {
      const err = validateNode(node.children[i], depth + 1, budget)
      if (err) return `children[${i}]: ${err}`
    }
    return null
  }
  if (node.kind === "container") {
    if (!Array.isArray(node.windowIds)) return "container.windowIds must be an array"
    if (node.windowIds.length > MAX_TABS) {
      return `container.windowIds must have at most ${MAX_TABS} entries`
    }
    for (let i = 0; i < node.windowIds.length; i++) {
      if (!str(node.windowIds[i], MAX_ID_LEN)) {
        return `windowIds[${i}] must be a string of 1..${MAX_ID_LEN} chars`
      }
    }
    if (
      node.activeWindowId !== null &&
      node.activeWindowId !== undefined &&
      !str(node.activeWindowId, MAX_ID_LEN)
    ) {
      return "container.activeWindowId must be a string or null"
    }
    return null
  }
  return "node.kind must be 'split' or 'container'"
}

/**
 * Structural validation of a UiStateReport (REQ-1 caps; NFR-5: never throws).
 * Strict on shape and caps, referentially consistent where the frontend
 * guarantees it (activeDesktopId must be a declared desktop; windowId must
 * match its key). `focusedWindowId` may dangle — the cost of leniency is nil
 * and rejecting a valid-but-transient snapshot would silently stale the mirror.
 */
export function validateUiStateReport(input: unknown): UiReportValidation {
  const bad = (reason: string): UiReportValidation => ({ ok: false, reason })
  if (!isPlainObject(input)) return bad("report must be a JSON object")
  try {
    if (JSON.stringify(input).length > UI_MAX_REPORT_BYTES) {
      return bad(`report exceeds ${UI_MAX_REPORT_BYTES} bytes`)
    }
  } catch {
    return bad("report is not serializable")
  }

  const workspaceId = str(input.workspaceId, MAX_ID_LEN)
  if (!workspaceId) return bad("workspaceId must be a string of 1..200 chars")
  const deviceId = str(input.deviceId, MAX_ID_LEN)
  if (!deviceId) return bad("deviceId must be a string of 1..200 chars")
  if (
    input.deviceLabel !== undefined &&
    (typeof input.deviceLabel !== "string" || input.deviceLabel.length > MAX_LABEL_LEN)
  ) {
    return bad(`deviceLabel must be a string of at most ${MAX_LABEL_LEN} chars`)
  }
  if (
    input.userAgent !== undefined &&
    (typeof input.userAgent !== "string" || input.userAgent.length === 0 || input.userAgent.length > MAX_UA_LEN)
  ) {
    return bad(`userAgent must be a string of 1..${MAX_UA_LEN} chars`)
  }

  if (!Array.isArray(input.desktops)) return bad("desktops must be an array")
  if (input.desktops.length < 1) return bad("desktops must contain at least one desktop")
  if (input.desktops.length > UI_MAX_DESKTOPS) {
    return bad(`at most ${UI_MAX_DESKTOPS} desktops allowed`)
  }
  const desktopIds = new Set<string>()
  for (let i = 0; i < input.desktops.length; i++) {
    const d = input.desktops[i]
    if (!isPlainObject(d)) return bad(`desktops[${i}] must be an object`)
    const desktopId = str(d.desktopId, MAX_ID_LEN)
    if (!desktopId) return bad(`desktops[${i}].desktopId must be a string of 1..200 chars`)
    if (desktopIds.has(desktopId)) return bad(`duplicate desktopId "${desktopId}"`)
    desktopIds.add(desktopId)
    if (d.name !== undefined && (typeof d.name !== "string" || d.name.length > MAX_LABEL_LEN)) {
      return bad(`desktops[${i}].name must be a string of at most ${MAX_LABEL_LEN} chars`)
    }
    if (d.layout !== null && d.layout !== undefined) {
      const err = validateNode(d.layout, 0, { count: 0 })
      if (err) return bad(`desktops[${i}].layout: ${err}`)
    }
  }

  const activeDesktopId = str(input.activeDesktopId, MAX_ID_LEN)
  if (!activeDesktopId) return bad("activeDesktopId must be a string of 1..200 chars")
  if (!desktopIds.has(activeDesktopId)) {
    return bad("activeDesktopId must be one of desktops[].desktopId")
  }

  if (!isPlainObject(input.windows)) return bad("windows must be an object keyed by windowId")
  const windowKeys = Object.keys(input.windows)
  if (windowKeys.length > UI_MAX_WINDOWS) {
    return bad(`at most ${UI_MAX_WINDOWS} windows allowed`)
  }
  for (const key of windowKeys) {
    if (key.length === 0 || key.length > MAX_ID_LEN) {
      return bad(`windows key "${key.slice(0, 32)}" must be 1..${MAX_ID_LEN} chars`)
    }
    const w = input.windows[key]
    if (!isPlainObject(w)) return bad(`windows["${key}"] must be an object`)
    const windowId = str(w.windowId, MAX_ID_LEN)
    if (!windowId) return bad(`windows["${key}"].windowId must be a string of 1..200 chars`)
    if (windowId !== key) return bad(`windows["${key}"].windowId must equal the key`)
    if (!str(w.type, MAX_TYPE_LEN)) {
      return bad(`windows["${key}"].type must be a string of 1..${MAX_TYPE_LEN} chars`)
    }
    if (!isPlainObject(w.props)) return bad(`windows["${key}"].props must be an object`)
    if (Object.keys(w.props).length > MAX_PROPS_KEYS) {
      return bad(`windows["${key}"].props has too many keys`)
    }
    if (w.title !== undefined && (typeof w.title !== "string" || w.title.length > MAX_TITLE_LEN)) {
      return bad(`windows["${key}"].title must be a string of at most ${MAX_TITLE_LEN} chars`)
    }
  }

  if (
    input.focusedWindowId !== null &&
    input.focusedWindowId !== undefined &&
    !str(input.focusedWindowId, MAX_ID_LEN)
  ) {
    return bad("focusedWindowId must be a string or null")
  }

  if (!Array.isArray(input.windowTypes)) return bad("windowTypes must be an array")
  if (input.windowTypes.length > UI_MAX_WINDOW_TYPES) {
    return bad(`at most ${UI_MAX_WINDOW_TYPES} window types allowed`)
  }
  for (let i = 0; i < input.windowTypes.length; i++) {
    const t = input.windowTypes[i]
    if (!isPlainObject(t)) return bad(`windowTypes[${i}] must be an object`)
    if (!str(t.type, MAX_TYPE_LEN)) {
      return bad(`windowTypes[${i}].type must be a string of 1..${MAX_TYPE_LEN} chars`)
    }
    if (!str(t.displayName, MAX_LABEL_LEN)) {
      return bad(`windowTypes[${i}].displayName must be a string of 1..${MAX_LABEL_LEN} chars`)
    }
    if (t.isLauncher !== undefined && typeof t.isLauncher !== "boolean") {
      return bad(`windowTypes[${i}].isLauncher must be a boolean`)
    }
    if (
      t.audience !== undefined &&
      !["user", "admin", "dev"].includes(t.audience as string)
    ) {
      return bad(`windowTypes[${i}].audience must be 'user', 'admin' or 'dev'`)
    }
  }

  return { ok: true, report: input as unknown as UiStateReport }
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class UiStateManager {
  /** key: `${userId}|${workspaceId}|${deviceId}` */
  private readonly entries = new Map<string, UiDeviceEntry>()
  private readonly nowFn: () => number
  private sweeper: ReturnType<typeof setInterval> | null = null
  private seq = 0

  constructor(opts: UiStateManagerOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now())
    const interval = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS
    if (interval > 0) {
      this.sweeper = setInterval(() => this.sweep(), interval)
      this.sweeper.unref?.()
    }
  }

  /** Stop the sweep and drop everything (tests / shutdown). */
  destroy(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    this.entries.clear()
  }

  private key(userId: string, workspaceId: string, deviceId: string): string {
    return `${userId}|${workspaceId}|${deviceId}`
  }

  private now(): number {
    return this.nowFn()
  }

  /** Structural validation (delegates to validateUiStateReport; never throws). */
  validateReport(input: unknown): UiReportValidation {
    return validateUiStateReport(input)
  }

  /**
   * Store/refresh a validated report and register the reporting session.
   * Clears any offline marking (the device demonstrably has a live client).
   * Enforces the ≤10 devices/user bound by evicting the stalest other device.
   */
  report(userId: string, sessionId: string, report: UiStateReport): UiDeviceEntry {
    const now = this.now()
    const key = this.key(userId, report.workspaceId, report.deviceId)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        userId,
        workspaceId: report.workspaceId,
        deviceId: report.deviceId,
        deviceLabel: report.deviceLabel,
        userAgent: report.userAgent,
        report,
        lastSeen: now,
        seq: 0,
        sessionIds: new Set(),
        offlineSince: null,
      }
      this.entries.set(key, entry)
    } else {
      entry.report = report
      if (report.deviceLabel !== undefined) entry.deviceLabel = report.deviceLabel
      if (report.userAgent !== undefined) entry.userAgent = report.userAgent
      entry.offlineSince = null
    }
    entry.lastSeen = now
    entry.seq = ++this.seq
    entry.sessionIds.add(sessionId)
    this.enforceDeviceCap(userId, report.workspaceId, key)
    return entry
  }

  /** All non-evicted devices of the user in the workspace, newest report first. */
  devices(userId: string, workspaceId: string): (UiDeviceEntry & { online: boolean })[] {
    const now = this.now()
    const out: (UiDeviceEntry & { online: boolean })[] = []
    for (const entry of this.entries.values()) {
      if (entry.userId !== userId || entry.workspaceId !== workspaceId) continue
      out.push({ ...entry, online: this.isOnline(entry, now) })
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen || b.seq - a.seq)
    return out
  }

  /** Devices with a live reporting session (grace included). */
  onlineDevices(userId: string, workspaceId: string): (UiDeviceEntry & { online: boolean })[] {
    return this.devices(userId, workspaceId).filter((d) => d.online)
  }

  /** REQ-2: online device with the most recent lastSeen (latest report wins ties). */
  activeDevice(userId: string, workspaceId: string): (UiDeviceEntry & { online: boolean }) | null {
    return this.onlineDevices(userId, workspaceId)[0] ?? null
  }

  /** Sessions that reported a device (targeted delivery); empty when unknown. */
  sessionsOfDevice(userId: string, workspaceId: string, deviceId: string): string[] {
    const entry = this.entries.get(this.key(userId, workspaceId, deviceId))
    return entry ? [...entry.sessionIds] : []
  }

  /**
   * WS session closed: unbind it. A device left without sessions starts the
   * offline countdown (it stays `online` for the grace window, then reads as
   * offline until it is evicted by the sweep or re-reported).
   */
  dropSession(sessionId: string): void {
    const now = this.now()
    for (const entry of this.entries.values()) {
      if (!entry.sessionIds.delete(sessionId)) continue
      if (entry.sessionIds.size === 0 && entry.offlineSince === null) entry.offlineSince = now
    }
  }

  /** TTL sweep: evict entries that lost their last session ≥ 5 min ago. */
  sweep(): number {
    const now = this.now()
    let evicted = 0
    for (const [key, entry] of this.entries) {
      if (entry.sessionIds.size > 0) continue
      const since = entry.offlineSince ?? entry.lastSeen
      if (now - since >= UI_EVICT_AFTER_MS) {
        this.entries.delete(key)
        evicted++
      }
    }
    return evicted
  }

  private isOnline(entry: UiDeviceEntry, now: number): boolean {
    if (entry.sessionIds.size > 0) return true
    return entry.offlineSince !== null && now - entry.offlineSince < UI_OFFLINE_GRACE_MS
  }

  /** Keep ≤ UI_MAX_DEVICES_PER_USER per (userId, workspaceId), never evicting `keepKey`. */
  private enforceDeviceCap(userId: string, workspaceId: string, keepKey: string): void {
    const others = [...this.entries].filter(
      ([key, entry]) =>
        entry.userId === userId && entry.workspaceId === workspaceId && key !== keepKey,
    )
    let excess = others.length + 1 - UI_MAX_DEVICES_PER_USER
    if (excess <= 0) return
    // Evict the stalest: sessionless entries first (offline the longest),
    // then the oldest lastSeen.
    others.sort(([, a], [, b]) => {
      const aLive = a.sessionIds.size > 0 ? 1 : 0
      const bLive = b.sessionIds.size > 0 ? 1 : 0
      if (aLive !== bLive) return aLive - bLive
      return (a.offlineSince ?? a.lastSeen) - (b.offlineSince ?? b.lastSeen)
    })
    for (const [key] of others) {
      if (excess-- <= 0) break
      this.entries.delete(key)
    }
  }
}
