/**
 * Dependency Injection Container Implementation
 *
 * Simple, lightweight DI container with:
 * - Singleton and transient lifecycles
 * - Lazy instantiation by default
 * - Eager initialization option
 * - Async factory support
 * - Scoped containers for request-level dependencies
 * - Automatic disposal of resources
 */

import type {
  AsyncFactory,
  Factory,
  IContainer,
  IDisposable,
  Lifecycle,
  Registration,
  RegistrationOptions,
  Token,
} from './types';

export class Container implements IContainer {
  private registrations = new Map<string | symbol, Registration>();
  private instances = new Map<string | symbol, any>();
  private parent: Container | null = null;
  private initialized = false;

  constructor(parent?: Container) {
    this.parent = parent ?? null;
  }

  register<T>(token: string | symbol, factory: Factory<T>, options?: RegistrationOptions): void {
    this.ensureNotInitialized('register');

    this.registrations.set(token, {
      factory,
      lifecycle: options?.lifecycle ?? 'singleton',
      eager: options?.eager ?? false,
      isAsync: false,
    });
  }

  registerAsync<T>(
    token: string | symbol,
    factory: AsyncFactory<T>,
    options?: RegistrationOptions,
  ): void {
    this.ensureNotInitialized('registerAsync');

    this.registrations.set(token, {
      factory,
      lifecycle: options?.lifecycle ?? 'singleton',
      eager: options?.eager ?? false,
      isAsync: true,
    });
  }

  registerInstance<T>(token: string | symbol, instance: T): void {
    this.registrations.set(token, {
      factory: () => instance,
      lifecycle: 'singleton',
      eager: false,
      isAsync: false,
    });
    this.instances.set(token, instance);
  }

  get<T>(token: Token<T>): T;
  get<T>(token: string | symbol): T;
  get<T>(token: string | symbol): T {
    // Check if we have a cached instance
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Check parent container
    if (this.parent?.has(token)) {
      return this.parent.get<T>(token);
    }

    // Get registration
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error(`Dependency not registered: ${String(token)}`);
    }

    // Check if async
    if (registration.isAsync) {
      throw new Error(`Dependency "${String(token)}" is async. Use getAsync() instead.`);
    }

    // Create instance
    const instance = (registration.factory as Factory<T>)(this);

    // Cache if singleton
    if (registration.lifecycle === 'singleton') {
      this.instances.set(token, instance);
    }

    return instance;
  }

  async getAsync<T>(token: string | symbol): Promise<T> {
    // Check if we have a cached instance
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Check parent container
    if (this.parent?.has(token)) {
      return this.parent.getAsync<T>(token);
    }

    // Get registration
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error(`Dependency not registered: ${String(token)}`);
    }

    // Create instance (handle both sync and async factories)
    const instance = registration.isAsync
      ? await (registration.factory as AsyncFactory<T>)(this)
      : (registration.factory as Factory<T>)(this);

    // Cache if singleton
    if (registration.lifecycle === 'singleton') {
      this.instances.set(token, instance);
    }

    return instance;
  }

  has(token: string | symbol | Token<any>): boolean {
    return this.registrations.has(token) || (this.parent?.has(token) ?? false);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize eager dependencies in registration order
    for (const [token, registration] of this.registrations) {
      if (registration.eager && !this.instances.has(token)) {
        if (registration.isAsync) {
          await this.getAsync(token);
        } else {
          this.get(token);
        }
      }
    }

    this.initialized = true;
  }

  async dispose(): Promise<void> {
    // Dispose in reverse order of creation
    const tokens = Array.from(this.instances.keys()).reverse();

    for (const token of tokens) {
      const instance = this.instances.get(token);
      if (this.isDisposable(instance)) {
        try {
          await instance.dispose();
        } catch (error) {
          console.error(`Error disposing ${String(token)}:`, error);
        }
      }
    }

    this.instances.clear();
    this.initialized = false;
  }

  createScope(): IContainer {
    return new Container(this);
  }

  /**
   * Get all registered tokens (useful for debugging)
   */
  getRegisteredTokens(): (string | symbol)[] {
    const tokens = new Set<string | symbol>();

    // Add parent tokens first
    if (this.parent) {
      for (const token of this.parent.getRegisteredTokens()) {
        tokens.add(token);
      }
    }

    // Add our tokens
    for (const token of this.registrations.keys()) {
      tokens.add(token);
    }

    return Array.from(tokens);
  }

  /**
   * Debug helper: print registration info
   */
  debug(): void {
    console.log('Container registrations:');
    for (const [token, reg] of this.registrations) {
      const hasInstance = this.instances.has(token);
      console.log(
        `  ${String(token)}: ${reg.lifecycle}${reg.eager ? ' (eager)' : ''}${
          reg.isAsync ? ' (async)' : ''
        }${hasInstance ? ' [instantiated]' : ''}`,
      );
    }
  }

  private ensureNotInitialized(operation: string): void {
    if (this.initialized) {
      console.warn(
        `Warning: ${operation}() called after init(). ` + `This may cause unexpected behavior.`,
      );
    }
  }

  private isDisposable(obj: any): obj is IDisposable {
    return obj && typeof obj.dispose === 'function';
  }
}

/**
 * Create a new container instance
 */
export function createContainer(): Container {
  return new Container();
}
