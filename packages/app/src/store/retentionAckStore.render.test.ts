import { describe, expect, it } from 'vitest'
import { useRetentionAckStore } from './retentionAckStore'
import { storeRegistry } from './session/StoreRegistry'

/**
 * The feature's UX promise — "ask once per model, even across page reloads" —
 * depends entirely on the `persist` middleware. The behavioural tests only
 * exercise in-memory state, so removing `persist()` would keep them green while
 * the modal reappears every session. These guard that wiring directly.
 */
describe('retentionAckStore — persistence & session lifecycle', () => {
  it('is wrapped with the persist middleware under a stable key', () => {
    // `.persist` only exists when the middleware is applied; getOptions().name
    // is the localStorage/AsyncStorage key.
    const persist = (useRetentionAckStore as unknown as { persist?: { getOptions: () => { name?: string } } }).persist
    expect(persist).toBeDefined()
    expect(persist?.getOptions().name).toBe('teros-retention-ack')
  })

  it('is registered in the storeRegistry so resetSession clears it on logout', () => {
    expect(storeRegistry.getRegisteredStores()).toContain('retentionAck')
  })

  it('reset() clears acknowledgements', () => {
    useRetentionAckStore.getState().ack('some-model:trains')
    expect(useRetentionAckStore.getState().isAcked('some-model:trains')).toBe(true)
    useRetentionAckStore.getState().reset()
    expect(useRetentionAckStore.getState().isAcked('some-model:trains')).toBe(false)
  })
})
