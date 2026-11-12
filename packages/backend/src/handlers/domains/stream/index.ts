/**
 * Stream domain — tickets for the MCA streams data plane
 * (spec docs/specs/20261104_mca-streams.md, MCS-REQ-7).
 *
 * Actions:
 *   stream.ticket → { ticket, path: '/ws/stream' } — single use, 60 s.
 *
 * Frontend sessions only: an MCA bridge call has no one watching, and a
 * ticket is the viewer's identity on the data plane (the relay checks the
 * stream's scope against it on attach).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { McaStreamRelay } from "../../../services/mca-stream-relay"
import { HandlerError, type WsRouter } from "../../../ws-framework/WsRouter"

export interface StreamDomainDeps {
  /** The relay is created after the WS handler (it needs the MCA connection manager): resolved per call. */
  getRelay: () => McaStreamRelay | null
}

function isBridgeCall(ctx: WsHandlerContext): boolean {
  return ctx.actor !== undefined || ctx.sessionId.startsWith("mca:")
}

export function register(router: WsRouter, deps: StreamDomainDeps): void {
  router.register("stream.ticket", async (ctx: WsHandlerContext) => {
    if (isBridgeCall(ctx)) {
      throw new HandlerError("FORBIDDEN", "stream.ticket is for the user's own frontend session")
    }
    const relay = deps.getRelay()
    if (!relay) {
      throw new HandlerError("STREAMS_UNAVAILABLE", "MCA streams are not available on this server")
    }
    return { ticket: relay.issueTicket(ctx.userId), path: "/ws/stream" }
  })
}
