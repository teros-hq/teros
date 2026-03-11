/**
 * Tests for DI Container
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createContainer, createToken } from '../../../packages/backend/src/container';

describe('DI Container', () => {
  describe('createContainer', () => {
    it('should create a new container instance', () => {
      const container = createContainer();
      expect(container).toBeDefined();
      expect(typeof container.register).toBe('function');
      expect(typeof container.get).toBe('function');
    });
  });

  describe('register and get', () => {
    it('should register and resolve a singleton', () => {
      const container = createContainer();
      const token = createToken<{ value: number }>('TestService');

      let instanceCount = 0;
      container.register(token, () => {
        instanceCount++;
        return { value: 42 };
      });

      const instance1 = container.get(token);
      const instance2 = container.get(token);

      expect(instance1.value).toBe(42);
      expect(instance1).toBe(instance2); // Same instance (singleton)
      expect(instanceCount).toBe(1); // Factory called only once
    });

    it('should register and resolve a transient', () => {
      const container = createContainer();
      const token = createToken<{ id: number }>('TransientService');

      let counter = 0;
      container.register(token, () => ({ id: ++counter }), { lifecycle: 'transient' });

      const instance1 = container.get(token);
      const instance2 = container.get(token);

      expect(instance1.id).toBe(1);
      expect(instance2.id).toBe(2);
      expect(instance1).not.toBe(instance2); // Different instances
    });

    it('should register an instance directly', () => {
      const container = createContainer();
      const token = createToken<{ name: string }>('Config');
      const config = { name: 'test-config' };

      container.registerInstance(token, config);

      const resolved = container.get(token);
      expect(resolved).toBe(config);
    });

    it('should throw when resolving unregistered token', () => {
      const container = createContainer();
      const token = createToken<string>('Unknown');

      expect(() => container.get(token)).toThrow();
    });
  });

  describe('dependency injection', () => {
    it('should inject dependencies through factory', () => {
      const container = createContainer();

      const dbToken = createToken<{ query: () => string }>('Db');
      const serviceToken = createToken<{ getData: () => string }>('Service');

      container.register(dbToken, () => ({
        query: () => 'data from db',
      }));

      container.register(serviceToken, (c) => {
        const db = c.get(dbToken);
        return {
          getData: () => `Service: ${db.query()}`,
        };
      });

      const service = container.get(serviceToken);
      expect(service.getData()).toBe('Service: data from db');
    });

    it('should support deep dependency chains', () => {
      const container = createContainer();

      const configToken = createToken<{ url: string }>('Config');
      const dbToken = createToken<{ connect: () => string }>('Db');
      const repoToken = createToken<{ find: () => string }>('Repo');
      const serviceToken = createToken<{ execute: () => string }>('Service');

      container.registerInstance(configToken, { url: 'mongodb://localhost' });

      container.register(dbToken, (c) => ({
        connect: () => `Connected to ${c.get(configToken).url}`,
      }));

      container.register(repoToken, (c) => ({
        find: () => `Repo using ${c.get(dbToken).connect()}`,
      }));

      container.register(serviceToken, (c) => ({
        execute: () => `Service: ${c.get(repoToken).find()}`,
      }));

      const service = container.get(serviceToken);
      expect(service.execute()).toBe('Service: Repo using Connected to mongodb://localhost');
    });
  });

  describe('async registration', () => {
    it('should support async factory registration', async () => {
      const container = createContainer();
      const token = createToken<{ data: string }>('AsyncService');

      container.registerAsync(token, async () => {
        // Simulate async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { data: 'async data' };
      });

      // Async dependencies must be resolved with getAsync()
      const instance = await container.getAsync(token);
      expect(instance.data).toBe('async data');
    });

    it('should initialize eager async dependencies', async () => {
      const container = createContainer();
      const token = createToken<{ ready: boolean }>('EagerService');

      let initialized = false;
      container.registerAsync(
        token,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          initialized = true;
          return { ready: true };
        },
        { eager: true },
      );

      expect(initialized).toBe(false);
      await container.init();
      expect(initialized).toBe(true);

      const instance = container.get(token);
      expect(instance.ready).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should call dispose on registered disposables', async () => {
      const container = createContainer();
      const token = createToken<{ dispose: () => Promise<void>; disposed: boolean }>('Disposable');

      const disposeMock = mock(() => Promise.resolve());

      container.register(token, () => ({
        dispose: disposeMock,
        disposed: false,
      }));

      // Get instance to create it
      container.get(token);

      await container.dispose();

      expect(disposeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('has', () => {
    it('should return true for registered tokens', () => {
      const container = createContainer();
      const token = createToken<string>('Test');

      expect(container.has(token)).toBe(false);

      container.register(token, () => 'test');

      expect(container.has(token)).toBe(true);
    });
  });

  describe('createToken', () => {
    it('should create unique tokens', () => {
      const token1 = createToken<string>('Service');
      const token2 = createToken<string>('Service');

      // Same name but different tokens (symbols)
      expect(token1).not.toBe(token2);
    });

    it('should preserve type information', () => {
      interface MyService {
        doSomething(): void;
      }

      const token = createToken<MyService>('MyService');
      const container = createContainer();

      container.register(token, () => ({
        doSomething: () => {},
      }));

      const service = container.get(token);
      // TypeScript should know this is MyService
      expect(typeof service.doSomething).toBe('function');
    });
  });
});
