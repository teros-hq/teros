/**
 * Bootstrap Modules
 *
 * Extracted from index.ts for maintainability.
 */

export { registerDependencies } from './container-setup'
export { createHttpHandler, MIME_TYPES, STATIC_DIR, UPLOADS_DIR, type HttpHandlers } from './http-server'
export { bootstrapServer, type BootstrapInput } from './server-bootstrap'
