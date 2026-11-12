/**
 * Tests for the Function Node Sandbox — code execution, tool calls,
 * timeout, error handling, and output mapping.
 */

import { describe, expect, it } from 'bun:test';

import { executeSandbox } from '../src/handlers/sandbox';
import type { ToolExecutor, ToolCallResult, ToolCallContext } from '../src/handlers/tool-executor';
import { NoopToolExecutor } from '../src/handlers/tool-executor';

// ============================================================================
// MOCK TOOL EXECUTOR
// ============================================================================

class MockToolExecutor implements ToolExecutor {
  private calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  private responses = new Map<string, ToolCallResult>();

  setResponse(toolName: string, result: ToolCallResult): void {
    this.responses.set(toolName, result);
  }

  getCalls(): Array<{ toolName: string; args: Record<string, unknown> }> {
    return [...this.calls];
  }

  async call(
    toolName: string,
    args: Record<string, unknown>,
    _context: ToolCallContext,
  ): Promise<ToolCallResult> {
    this.calls.push({ toolName, args });
    const response = this.responses.get(toolName);
    if (response) return response;
    return {
      output: `Mock result for ${toolName}`,
      isError: false,
      mcaId: 'mock',
    };
  }

  async listTools(_context: ToolCallContext): Promise<string[]> {
    return ['mock_tool', 'notion_create_page', 'gmail_send_email'];
  }
}

// ============================================================================
// SANDBOX TESTS
// ============================================================================

describe('Sandbox — executeSandbox', () => {
  const defaultContext: ToolCallContext = {
    userId: 'user_test',
    workspaceId: 'ws_test',
    agentId: 'agent_test',
  };

  it('executes simple code and returns output', async () => {
    const result = await executeSandbox({
      code: 'return 42;',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });

  it('can access input data', async () => {
    const result = await executeSandbox({
      code: 'return input.name;',
      inputData: { name: 'Alice', age: 30 },
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('Alice');
  });

  it('can call MCA tools via the tools object', async () => {
    const executor = new MockToolExecutor();
    executor.setResponse('notion_create_page', {
      output: JSON.stringify({ pageId: 'page_123', url: 'https://notion.so/page_123' }),
      isError: false,
      mcaId: 'notion',
    });

    const result = await executeSandbox({
      code: `
        const result = await tools.notion_create_page({
          title: input.name,
          parentId: 'abc'
        });
        return JSON.parse(result.output);
      `,
      inputData: { name: 'Test Lead' },
      toolExecutor: executor,
      toolCallContext: defaultContext,
      availableTools: ['notion_create_page'],
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.pageId).toBe('page_123');

    const calls = executor.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('notion_create_page');
    expect(calls[0].args.title).toBe('Test Lead');
  });

  it('handles tool call errors gracefully', async () => {
    const executor = new MockToolExecutor();
    executor.setResponse('gmail_send_email', {
      output: 'Failed to send email: invalid recipient',
      isError: true,
      mcaId: 'gmail',
    });

    const result = await executeSandbox({
      code: `
        const result = await tools.gmail_send_email({
          to: 'invalid',
          subject: 'Test',
          body: 'Hello'
        });
        if (result.isError) {
          return { error: result.output };
        }
        return { success: true };
      `,
      inputData: {},
      toolExecutor: executor,
      toolCallContext: defaultContext,
      availableTools: ['gmail_send_email'],
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.error).toContain('Failed to send email');
  });

  it('captures console output', async () => {
    const result = await executeSandbox({
      code: `
        console.log('Processing input:', input.name);
        console.warn('This is a warning');
        return input.name;
      `,
      inputData: { name: 'Test' },
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.logs).toContain('Processing input: Test');
    expect(result.logs.some(l => l.includes('[WARN]'))).toBe(true);
  });

  it('handles syntax errors', async () => {
    const result = await executeSandbox({
      code: 'this is not valid javascript {{{',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error!).toContain('SyntaxError');
  });

  it('handles runtime errors', async () => {
    const result = await executeSandbox({
      code: 'throw new Error("Custom error from sandbox");',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Custom error from sandbox');
  });

  it('enforces timeout for synchronous infinite loops', async () => {
    const result = await executeSandbox({
      code: 'while(true) {}',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
      timeoutMs: 500,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('supports async/await with multiple tool calls', async () => {
    const executor = new MockToolExecutor();

    const result = await executeSandbox({
      code: `
        const [page, email] = await Promise.all([
          tools.notion_create_page({ title: input.name }),
          tools.gmail_send_email({ to: input.email }),
        ]);
        return {
          pageResult: page.output,
          emailResult: email.output,
        };
      `,
      inputData: { name: 'Test', email: 'test@example.com' },
      toolExecutor: executor,
      toolCallContext: defaultContext,
      availableTools: ['notion_create_page', 'gmail_send_email'],
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.pageResult).toContain('Mock result');
    expect(output.emailResult).toContain('Mock result');

    expect(executor.getCalls()).toHaveLength(2);
  });

  it('provides utility functions', async () => {
    const result = await executeSandbox({
      code: `
        const json = utils.stringify({ name: input.name });
        const parsed = utils.parse(json);
        return parsed.name;
      `,
      inputData: { name: 'Alice' },
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('Alice');
  });

  it('cannot access process or require', async () => {
    const result = await executeSandbox({
      code: 'return typeof process;',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    // process should be undefined in the sandbox
    expect(result.success).toBe(true);
    expect(result.output).toBe('undefined');
  });

  it('cannot access global or globalThis process', async () => {
    const result = await executeSandbox({
      code: 'return typeof globalThis.process;',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('undefined');
  });

  it('returns undefined when code has no return statement', async () => {
    const result = await executeSandbox({
      code: 'const x = 1 + 1;',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeUndefined();
  });

  it('handles null and undefined return values', async () => {
    const result = await executeSandbox({
      code: 'return null;',
      inputData: {},
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeNull();
  });

  it('supports complex data transformation', async () => {
    const result = await executeSandbox({
      code: `
        const leads = input.leads;
        const transformed = leads.map(l => ({
          id: l.id,
          fullName: l.firstName + ' ' + l.lastName,
          email: l.email.toLowerCase(),
        }));
        return transformed;
      `,
      inputData: {
        leads: [
          { id: 1, firstName: 'Alice', lastName: 'Smith', email: 'ALICE@EXAMPLE.COM' },
          { id: 2, firstName: 'Bob', lastName: 'Jones', email: 'BOB@EXAMPLE.COM' },
        ],
      },
      toolExecutor: new NoopToolExecutor(),
      toolCallContext: defaultContext,
      availableTools: [],
    });

    expect(result.success).toBe(true);
    const output = result.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(2);
    expect(output[0].fullName).toBe('Alice Smith');
    expect(output[0].email).toBe('alice@example.com');
  });
});
