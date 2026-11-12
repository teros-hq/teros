/**
 * McaActionError — extracted from ./index to break the import cycle
 * (index → evaluator → index). Capabilities import the error from here;
 * ./index re-exports it so existing importers are unaffected.
 */

import { HandlerError } from '../ws-framework/WsRouter';

/**
 * A HandlerError that also carries the HTTP status to answer with and an
 * optional user-facing suggestion. Lets a capability keep its own domain
 * error codes (e.g. `NO_START_NODE`, `ALREADY_TERMINAL`) — which thin-client
 * MCAs forward verbatim to the UI — while the dispatcher still maps the
 * response status correctly.
 */
export class McaActionError extends HandlerError {
  constructor(
    code: string,
    message: string,
    public readonly status: number = 400,
    public readonly suggestion?: string,
  ) {
    super(code, message);
    this.name = 'McaActionError';
  }
}
