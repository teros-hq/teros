import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WsRouter, HandlerError } from '../../src/ws-framework/WsRouter';

// Minimal WebSocket mock
function createMockWs() {
  const sent: string[] = [];
  return {
    send: vi.fn((data: string) => { sent.push(data); }),
    sent,
    /** Parse the last sent message */
    lastMessage(): any {
      return JSON.parse(sent[sent.length - 1]);
    },
    /** Parse all sent messages */
    allMessages(): any[] {
      return sent.map((s) => JSON.parse(s));
    },
  } as any;
}

const baseCtx = { userId: 'user_1', sessionId: 'sess_1' };

describe('WsRouter', () => {
  let router: WsRouter;

  beforeEach(() => {
    router = new WsRouter();
  });

  // ==========================================================================
  // REGISTRATION
  // ==========================================================================

  describe('register', () => {
    it('should register a handler for an action', () => {
      const handler = vi.fn();
      router.register('profile.get', handler);
      expect(router.has('profile.get')).toBe(true);
    });

    it('should throw if registering a duplicate action', () => {
      router.register('profile.get', vi.fn());
      expect(() => router.register('profile.get', vi.fn())).toThrow(
        'Handler already registered for action: profile.get',
      );
    });

    it('should list all registered actions sorted', () => {
      router.register('channels.create', vi.fn());
      router.register('agents.list', vi.fn());
      router.register('profile.get', vi.fn());
      expect(router.listActions()).toEqual([
        'agents.list',
        'channels.create',
        'profile.get',
      ]);
    });

    it('should return false for unregistered actions', () => {
      expect(router.has('nonexistent.action')).toBe(false);
    });
  });

  // ==========================================================================
  // DISPATCH
  // ==========================================================================

  describe('dispatch', () => {
    it('should call the handler and send a response', async () => {
      const ws = createMockWs();
      router.register('profile.get', async () => ({ name: 'Alice' }));

      await router.dispatch(ws, baseCtx, 'req_1', 'profile.get', {});

      const msg = ws.lastMessage();
      expect(msg.type).toBe('response');
      expect(msg.requestId).toBe('req_1');
      expect(msg.data).toEqual({ name: 'Alice' });
    });

    it('should pass context and data to the handler', async () => {
      const ws = createMockWs();
      const handler = vi.fn(async (ctx: any, data: any) => ({ received: data }));
      router.register('test.echo', handler);

      await router.dispatch(ws, baseCtx, 'req_2', 'test.echo', { foo: 'bar' });

      expect(handler).toHaveBeenCalledWith(baseCtx, { foo: 'bar' });
    });

    it('should send UNKNOWN_ACTION error for unregistered actions', async () => {
      const ws = createMockWs();

      await router.dispatch(ws, baseCtx, 'req_3', 'nonexistent.action', {});

      const msg = ws.lastMessage();
      expect(msg.type).toBe('error');
      expect(msg.requestId).toBe('req_3');
      expect(msg.code).toBe('UNKNOWN_ACTION');
      expect(msg.message).toContain('nonexistent.action');
    });

    it('should send error when handler throws a generic Error', async () => {
      const ws = createMockWs();
      router.register('test.fail', async () => {
        throw new Error('Something went wrong');
      });

      await router.dispatch(ws, baseCtx, 'req_4', 'test.fail', {});

      const msg = ws.lastMessage();
      expect(msg.type).toBe('error');
      expect(msg.requestId).toBe('req_4');
      expect(msg.code).toBe('INTERNAL_ERROR');
      expect(msg.message).toBe('Something went wrong');
    });

    it('should use HandlerError code when handler throws HandlerError', async () => {
      const ws = createMockWs();
      router.register('test.deny', async () => {
        throw new HandlerError('ACCESS_DENIED', 'You cannot do that');
      });

      await router.dispatch(ws, baseCtx, 'req_5', 'test.deny', {});

      const msg = ws.lastMessage();
      expect(msg.type).toBe('error');
      expect(msg.requestId).toBe('req_5');
      expect(msg.code).toBe('ACCESS_DENIED');
      expect(msg.message).toBe('You cannot do that');
    });

    it('should handle concurrent dispatches independently', async () => {
      const ws = createMockWs();

      router.register('slow', async (_, data: any) => {
        await new Promise((r) => setTimeout(r, data.delay));
        return { id: data.id };
      });

      // Fire 3 requests concurrently with different delays
      await Promise.all([
        router.dispatch(ws, baseCtx, 'req_a', 'slow', { id: 1, delay: 30 }),
        router.dispatch(ws, baseCtx, 'req_b', 'slow', { id: 2, delay: 10 }),
        router.dispatch(ws, baseCtx, 'req_c', 'slow', { id: 3, delay: 20 }),
      ]);

      const messages = ws.allMessages();
      expect(messages).toHaveLength(3);

      // Each response should have the correct requestId and data
      const byReqId = new Map(messages.map((m: any) => [m.requestId, m]));
      expect(byReqId.get('req_a').data).toEqual({ id: 1 });
      expect(byReqId.get('req_b').data).toEqual({ id: 2 });
      expect(byReqId.get('req_c').data).toEqual({ id: 3 });
    });
  });

  // ==========================================================================
  // MIDDLEWARE
  // ==========================================================================

  describe('middleware', () => {
    it('should call middleware before the handler', async () => {
      const ws = createMockWs();
      const callOrder: string[] = [];

      router.use(async (_ctx, _action, _data, next) => {
        callOrder.push('middleware');
        return next();
      });

      router.register('test.order', async () => {
        callOrder.push('handler');
        return { ok: true };
      });

      await router.dispatch(ws, baseCtx, 'req_1', 'test.order', {});

      expect(callOrder).toEqual(['middleware', 'handler']);
    });

    it('should chain multiple middlewares in order', async () => {
      const ws = createMockWs();
      const callOrder: string[] = [];

      router.use(async (_ctx, _action, _data, next) => {
        callOrder.push('mw1-before');
        const result = await next();
        callOrder.push('mw1-after');
        return result;
      });

      router.use(async (_ctx, _action, _data, next) => {
        callOrder.push('mw2-before');
        const result = await next();
        callOrder.push('mw2-after');
        return result;
      });

      router.register('test.chain', async () => {
        callOrder.push('handler');
        return {};
      });

      await router.dispatch(ws, baseCtx, 'req_1', 'test.chain', {});

      expect(callOrder).toEqual([
        'mw1-before',
        'mw2-before',
        'handler',
        'mw2-after',
        'mw1-after',
      ]);
    });

    it('should allow middleware to access action and data', async () => {
      const ws = createMockWs();
      let capturedAction = '';
      let capturedData: any = null;

      router.use(async (_ctx, action, data, next) => {
        capturedAction = action;
        capturedData = data;
        return next();
      });

      router.register('test.inspect', async () => ({ ok: true }));

      await router.dispatch(ws, baseCtx, 'req_1', 'test.inspect', { key: 'value' });

      expect(capturedAction).toBe('test.inspect');
      expect(capturedData).toEqual({ key: 'value' });
    });

    it('should propagate handler errors through middleware', async () => {
      const ws = createMockWs();
      let caughtInMiddleware = false;

      router.use(async (_ctx, _action, _data, next) => {
        try {
          return await next();
        } catch (error) {
          caughtInMiddleware = true;
          throw error; // re-throw so router handles it
        }
      });

      router.register('test.throws', async () => {
        throw new HandlerError('BOOM', 'Exploded');
      });

      await router.dispatch(ws, baseCtx, 'req_1', 'test.throws', {});

      expect(caughtInMiddleware).toBe(true);
      const msg = ws.lastMessage();
      expect(msg.code).toBe('BOOM');
    });
  });
});
