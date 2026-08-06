import type { ChannelWorker, ChannelWorkerRegistry } from '@teros/core'
import type { ChannelManager } from './channel-manager'

const IDLE_DEBOUNCE_MS = 250
const TYPING_HEARTBEAT_MS = 10_000

interface ChannelTypingContext {
  agentId: string
  broadcastToChannel: (channelId: string, message: unknown) => void
}

export class ChannelRunningTracker {
  private bound = new Set<string>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  private typingContexts = new Map<string, ChannelTypingContext>()
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private registry: ChannelWorkerRegistry,
    private channelManager: ChannelManager,
  ) {
    this.registry.on('worker.created', (channelId: string, worker: ChannelWorker) => {
      if (this.bound.has(channelId)) return
      this.bound.add(channelId)
      this.wire(channelId, worker)
    })
    this.registry.on('worker.disposed', (channelId: string) => {
      this.bound.delete(channelId)
      this.cancelIdleTimer(channelId)
      this.stopTyping(channelId)
      this.typingContexts.delete(channelId)
    })
  }

  registerTypingContext(channelId: string, ctx: ChannelTypingContext): void {
    this.typingContexts.set(channelId, ctx)
  }

  __resetForTests(): void {
    for (const t of this.idleTimers.values()) clearTimeout(t)
    this.idleTimers.clear()
    for (const t of this.typingHeartbeats.values()) clearInterval(t)
    this.typingHeartbeats.clear()
    this.bound.clear()
    this.typingContexts.clear()
  }

  private wire(channelId: string, worker: ChannelWorker): void {
    worker.on('item.started', () => {
      this.cancelIdleTimer(channelId)
      this.channelManager.setRunning(channelId, true).catch(() => undefined)
      this.startTyping(channelId)
    })

    worker.on('idle', () => {
      // Debounced so a new queued item within the gap doesn't flicker
      // `running` / typing off and back on.
      this.cancelIdleTimer(channelId)
      const timer = setTimeout(() => {
        this.idleTimers.delete(channelId)
        const w = this.registry.get(channelId)
        if (w && w.inspect().lifecycle === 'idle') {
          this.channelManager.setRunning(channelId, false).catch(() => undefined)
          this.stopTyping(channelId)
        }
      }, IDLE_DEBOUNCE_MS)
      this.idleTimers.set(channelId, timer)
    })

    worker.on('fatal', () => {
      this.cancelIdleTimer(channelId)
      this.bound.delete(channelId)
      this.channelManager.setRunning(channelId, false).catch(() => undefined)
      this.stopTyping(channelId)
    })
  }

  private startTyping(channelId: string): void {
    const ctx = this.typingContexts.get(channelId)
    if (!ctx) return
    const existing = this.typingHeartbeats.get(channelId)
    if (existing) clearInterval(existing)

    ctx.broadcastToChannel(channelId, {
      type: 'typing',
      channelId,
      agentId: ctx.agentId,
      isTyping: true,
    })
    const interval = setInterval(() => {
      ctx.broadcastToChannel(channelId, {
        type: 'typing',
        channelId,
        agentId: ctx.agentId,
        isTyping: true,
      })
    }, TYPING_HEARTBEAT_MS)
    this.typingHeartbeats.set(channelId, interval)
  }

  private stopTyping(channelId: string): void {
    const ctx = this.typingContexts.get(channelId)
    if (!ctx) return
    const existing = this.typingHeartbeats.get(channelId)
    if (existing) {
      clearInterval(existing)
      this.typingHeartbeats.delete(channelId)
    }
    ctx.broadcastToChannel(channelId, {
      type: 'typing',
      channelId,
      agentId: ctx.agentId,
      isTyping: false,
    })
  }

  private cancelIdleTimer(channelId: string): void {
    const t = this.idleTimers.get(channelId)
    if (t) {
      clearTimeout(t)
      this.idleTimers.delete(channelId)
    }
  }
}
