/**
 * Dependency Injection Container - Type Definitions
 *
 * A simple but powerful DI container for Teros backend.
 * Supports singleton and transient lifecycles, lazy instantiation,
 * and type-safe dependency resolution.
 */

/**
 * Lifecycle of a registered dependency
 * - singleton: Created once, reused for all requests
 * - transient: Created new for each request
 */
export type Lifecycle = 'singleton' | 'transient';

/**
 * Factory function that creates an instance
 * Receives the container to resolve dependencies
 */
export type Factory<T> = (container: IContainer) => T;

/**
 * Async factory for dependencies that need async initialization
 */
export type AsyncFactory<T> = (container: IContainer) => Promise<T>;

/**
 * Registration options
 */
export interface RegistrationOptions {
  /** Lifecycle of the dependency (default: singleton) */
  lifecycle?: Lifecycle;
  /** If true, instance is created at container.init() time */
  eager?: boolean;
}

/**
 * Service registration entry
 */
export interface Registration<T = any> {
  factory: Factory<T> | AsyncFactory<T>;
  lifecycle: Lifecycle;
  eager: boolean;
  isAsync: boolean;
}

/**
 * Container interface
 *
 * @example
 * ```typescript
 * // Register services
 * container.register('db', () => connectToMongo(), { eager: true });
 * container.register('mcaService', (c) => new McaService(c.get('db')));
 * container.register('logger', () => createLogger(), { lifecycle: 'transient' });
 *
 * // Resolve dependencies
 * const mcaService = container.get<IMcaService>('mcaService');
 *
 * // With type-safe tokens
 * const mcaService = container.get(Tokens.McaService);
 * ```
 */
export interface IContainer {
  /**
   * Register a dependency with a factory function
   *
   * @param token - Unique identifier for the dependency
   * @param factory - Function that creates the instance
   * @param options - Registration options (lifecycle, eager)
   */
  register<T>(token: string | symbol, factory: Factory<T>, options?: RegistrationOptions): void;

  /**
   * Register an async dependency
   * Must be resolved with getAsync()
   */
  registerAsync<T>(
    token: string | symbol,
    factory: AsyncFactory<T>,
    options?: RegistrationOptions,
  ): void;

  /**
   * Register an existing instance directly
   * Always singleton lifecycle
   */
  registerInstance<T>(token: string | symbol, instance: T): void;

  /**
   * Get a dependency by token
   * Throws if dependency is async (use getAsync instead)
   * Throws if dependency not found
   */
  get<T>(token: string | symbol): T;

  /**
   * Get an async dependency by token
   * Works for both sync and async registrations
   */
  getAsync<T>(token: string | symbol): Promise<T>;

  /**
   * Check if a dependency is registered
   */
  has(token: string | symbol): boolean;

  /**
   * Initialize all eager dependencies
   * Call this after all registrations, before using the container
   */
  init(): Promise<void>;

  /**
   * Dispose all singleton instances
   * Calls dispose() on instances that implement IDisposable
   */
  dispose(): Promise<void>;

  /**
   * Create a child container that inherits registrations
   * Useful for request-scoped dependencies
   */
  createScope(): IContainer;
}

/**
 * Interface for disposable resources
 */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

/**
 * Type-safe token definition
 *
 * @example
 * ```typescript
 * const Tokens = {
 *   Db: Symbol('Db') as Token<Db>,
 *   McaService: Symbol('McaService') as Token<IMcaService>,
 * };
 *
 * // Type-safe resolution
 * const db = container.get(Tokens.Db); // type: Db
 * ```
 */
export type Token<T> = symbol & { __type?: T };

/**
 * Helper to create typed tokens
 */
export function createToken<T>(name: string): Token<T> {
  return Symbol(name) as Token<T>;
}
