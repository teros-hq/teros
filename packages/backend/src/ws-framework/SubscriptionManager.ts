/**
 * SubscriptionManager — Tracks WebSocket subscriptions per connection
 *
 * Channels follow the format "{domain}:{resourceId}" (e.g. "board:proj_123").
 * Automatically cleans up when a connection closes.
 */

import type { WebSocket } from 'ws';

export class SubscriptionManager {
  /** channel → Set of subscribed WebSocket connections */
  private subscriptions = new Map<string, Set<WebSocket>>();

  /** ws → Set of channels it's subscribed to (for fast cleanup) */
  private connectionChannels = new Map<WebSocket, Set<string>>();

  /** Subscribe a connection to a channel */
  subscribe(ws: WebSocket, channel: string): void {
    // Add to channel → connections map
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)!.add(ws);

    // Add to connection → channels map
    if (!this.connectionChannels.has(ws)) {
      this.connectionChannels.set(ws, new Set());
    }
    this.connectionChannels.get(ws)!.add(channel);
  }

  /** Unsubscribe a connection from a channel */
  unsubscribe(ws: WebSocket, channel: string): void {
    this.subscriptions.get(channel)?.delete(ws);
    if (this.subscriptions.get(channel)?.size === 0) {
      this.subscriptions.delete(channel);
    }

    this.connectionChannels.get(ws)?.delete(channel);
    if (this.connectionChannels.get(ws)?.size === 0) {
      this.connectionChannels.delete(ws);
    }
  }

  /** Remove a connection from all its subscriptions (call on disconnect) */
  cleanup(ws: WebSocket): void {
    const channels = this.connectionChannels.get(ws);
    if (!channels) return;

    for (const channel of channels) {
      this.subscriptions.get(channel)?.delete(ws);
      if (this.subscriptions.get(channel)?.size === 0) {
        this.subscriptions.delete(channel);
      }
    }

    this.connectionChannels.delete(ws);
  }

  /** Push an event to all subscribers of a channel */
  publish(channel: string, event: string, data: unknown): void {
    const subscribers = this.subscriptions.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({
      type: 'event',
      event,
      channel,
      data,
    });

    for (const ws of subscribers) {
      try {
        ws.send(message);
      } catch {
        // Connection might be dead — cleanup will handle it
      }
    }
  }

  /** Get the number of subscribers for a channel */
  subscriberCount(channel: string): number {
    return this.subscriptions.get(channel)?.size ?? 0;
  }

  /** Get all channels a connection is subscribed to */
  getChannels(ws: WebSocket): string[] {
    return Array.from(this.connectionChannels.get(ws) ?? []);
  }
}
