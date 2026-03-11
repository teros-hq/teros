/**
 * Dependency Injection Container
 *
 * @example
 * ```typescript
 * import { createContainer, Tokens, type Container } from './container';
 *
 * const container = createContainer();
 *
 * // Register dependencies
 * container.registerInstance(Tokens.Db, db);
 * container.register(Tokens.McaService, (c) => new McaService(c.get(Tokens.Db)));
 *
 * // Initialize eager dependencies
 * await container.init();
 *
 * // Use dependencies
 * const mcaService = container.get(Tokens.McaService);
 * ```
 */

// Re-export Container type for convenience
export type { Container as ContainerType } from './Container';
export { Container, createContainer } from './Container';
export { type AppConfig, Tokens, type TokenType } from './tokens';
export {
  type AsyncFactory,
  createToken,
  type Factory,
  type IContainer,
  type IDisposable,
  type Lifecycle,
  type Registration,
  type RegistrationOptions,
  type Token,
} from './types';
