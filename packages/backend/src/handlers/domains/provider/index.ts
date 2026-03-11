/**
 * Provider domain — registers all provider handlers with the router
 *
 * Actions:
 *   provider.list           → List all providers for the current user
 *   provider.add            → Add a new provider with credentials
 *   provider.test           → Test connection and discover models
 *   provider.update         → Update provider settings (displayName, priority, status)
 *   provider.delete         → Remove a provider
 *   provider.start-oauth    → Start OAuth flow for a provider
 *   provider.complete-oauth → Complete OAuth flow with callback URL
 *   provider.list-models    → List available LLM models
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { ProviderService } from '../../../services/provider-service'
import type { Db } from 'mongodb'

import { createListProvidersHandler } from './list'
import { createAddProviderHandler } from './add'
import { createTestProviderHandler } from './test'
import { createUpdateProviderHandler } from './update'
import { createDeleteProviderHandler } from './delete'
import { createStartOAuthHandler } from './start-oauth'
import { createCompleteOAuthHandler } from './complete-oauth'
import { createListModelsHandler } from './list-models'

export interface ProviderDomainDeps {
  db: Db
  providerService: ProviderService
}

export function register(router: WsRouter, deps: ProviderDomainDeps): void {
  const { db, providerService } = deps

  router.register('provider.list', createListProvidersHandler(providerService))
  router.register('provider.add', createAddProviderHandler(providerService))
  router.register('provider.test', createTestProviderHandler(providerService))
  router.register('provider.update', createUpdateProviderHandler(db, providerService))
  router.register('provider.delete', createDeleteProviderHandler(db, providerService))
  router.register('provider.start-oauth', createStartOAuthHandler())
  router.register('provider.complete-oauth', createCompleteOAuthHandler(providerService))
  router.register('provider.list-models', createListModelsHandler(db))
}
