/**
 * Navbar domain — the two anchored zones of the navbar (NAV spec v2.0.0).
 *
 * Actions: navbar.list · navbar.pin · navbar.unpin · navbar.update · navbar.move · navbar.reorder
 *
 * @spec NAV-REQ-3, NAV-REQ-4, NAV-REQ-10, NAV-REQ-17
 */
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'
import { NavbarPinError } from '../../../services/navbar-pins-service'
import { createListPinsHandler } from './list'
import { createPinHandler } from './pin'
import { createUnpinHandler } from './unpin'
import { createUpdatePinHandler } from './update'
import { createMovePinHandler } from './move'
import { createReorderPinsHandler } from './reorder'

export interface NavbarDomainDeps {
  navbarPinsService: NavbarPinsService
}

/** Translate service errors into handler errors (one place for the six actions). */
export function wrapPinErrors<T extends (...args: any[]) => Promise<unknown>>(fn: T): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (e) {
      if (e instanceof NavbarPinError) throw new HandlerError(e.code, e.message)
      throw e
    }
  }) as T
}

/** @spec NAV-REQ-10 */
export function register(router: WsRouter, deps: NavbarDomainDeps): void {
  const s = deps.navbarPinsService
  router.register('navbar.list', wrapPinErrors(createListPinsHandler(s)))
  router.register('navbar.pin', wrapPinErrors(createPinHandler(s)))
  router.register('navbar.unpin', wrapPinErrors(createUnpinHandler(s)))
  router.register('navbar.update', wrapPinErrors(createUpdatePinHandler(s)))
  router.register('navbar.move', wrapPinErrors(createMovePinHandler(s)))
  router.register('navbar.reorder', wrapPinErrors(createReorderPinsHandler(s)))
}
