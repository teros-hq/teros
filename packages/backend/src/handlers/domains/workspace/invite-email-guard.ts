/**
 * Invitation email guard (MUW-REQ-24): an invitation only goes to an address
 * that can be delivered. Syntactically valid addresses on reserved or
 * special-use domains (`.local`, `.localhost`, `.invalid`, `.test`,
 * `.example`, `example.com/.net/.org`, bare hosts) are refused BEFORE any
 * email is attempted, so the sender reputation never pays for a typo.
 *
 * @spec MUW-REQ-24
 */
import { HandlerError } from '../../../ws-framework/WsRouter'

/** Special-use TLDs that never resolve on the public Internet (RFC 2606 / RFC 6761). */
const RESERVED_TLDS = new Set(['local', 'localhost', 'invalid', 'test', 'example', 'onion', 'internal', 'home', 'lan'])
/** Reserved second-level domains (RFC 2606). */
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org'])

export function isInvitableEmail(raw: string): boolean {
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return false
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length > 64 || /\s/.test(email)) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false // bare host (no public TLD)
  if (labels.some((l) => l.length === 0 || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return false
  const tld = labels[labels.length - 1]
  if (tld.length < 2 || /^[0-9]+$/.test(tld)) return false
  if (RESERVED_TLDS.has(tld)) return false
  if (RESERVED_DOMAINS.has(labels.slice(-2).join('.'))) return false
  return true
}

/** @throws HandlerError('INVALID_EMAIL') */
export function assertInvitableEmail(email: string): void {
  if (!isInvitableEmail(email)) {
    throw new HandlerError('INVALID_EMAIL', 'This email address cannot receive an invitation (invalid or reserved domain)')
  }
}
