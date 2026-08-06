import { ChannelWorkerRegistry } from '@teros/core'

let registry: ChannelWorkerRegistry | null = null

export function getChannelWorkerRegistry(): ChannelWorkerRegistry {
  if (!registry) {
    registry = new ChannelWorkerRegistry()
  }
  return registry
}

export function __resetChannelWorkerRegistryForTests(): void {
  registry = null
}

/** Test-only setter: inject a fake registry so handlers under test pick it up. */
export function __setChannelWorkerRegistryForTests(
  fake: Pick<ChannelWorkerRegistry, 'get' | 'getOrCreate'> | ChannelWorkerRegistry,
): void {
  registry = fake as ChannelWorkerRegistry
}
