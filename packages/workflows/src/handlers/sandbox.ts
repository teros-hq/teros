/**
 * Function Node Sandbox
 *
 * Safely executes user-provided JavaScript code in an isolated Node.js VM
 * context with access to MCA tools, input data, and utility functions.
 *
 * Security model:
 * - Uses Node.js `vm` module to create a sandboxed context
 * - No access to `require`, `process`, `global`, `globalThis`, `__dirname`,
 *   `__filename`, `constructor`, or the file system
 * - Only exposes: `input`, `tools`, `utils`, `console` (log/warn/error)
 * - Async code is supported via async function wrapper
 * - Configurable timeout (default: 30s, max: 120s)
 * - Tool calls are async and go through the ToolExecutor interface
 *
 * Usage in function node code:
 * ```js
 * // Access input data from gates
 * const lead = input.lead;  // if gate is named "lead"
 *
 * // Call MCA tools
 * const result = await tools.notion_create_page({
 *   parentId: 'abc123',
 *   title: lead.name,
 *   content: lead.notes,
 * });
 *
 * // Return output data (mapped to output gates)
 * return { page_id: result.output };
 * ```
 */

import vm from 'node:vm';
import type { ToolExecutor, ToolCallContext, ToolCallResult } from './tool-executor';

// ============================================================================
// TYPES
// ============================================================================

export interface SandboxOptions {
  /** The JavaScript code to execute */
  code: string;
  /** Input data keyed by gate ID (e.g., { lead: {...}, email: {...} }) */
  inputData: Record<string, unknown>;
  /** Tool executor for calling MCA tools */
  toolExecutor: ToolExecutor;
  /** Context for tool calls (user, workspace, agent) */
  toolCallContext: ToolCallContext;
  /** Available tool names (to populate the `tools` object) */
  availableTools: string[];
  /** Timeout in milliseconds (default: 30_000, max: 120_000) */
  timeoutMs?: number;
}

export interface SandboxResult {
  /** Whether execution succeeded */
  success: boolean;
  /** The return value of the user code (mapped to output gates) */
  output?: unknown;
  /** Error message if execution failed */
  error?: string;
  /** Console output captured during execution */
  logs: string[];
}

// ============================================================================
// SANDBOX EXECUTION
// ============================================================================

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute user JavaScript code in a sandboxed VM context.
 *
 * The code runs inside an async function wrapper, so it can use `await`.
 * The `tools` object exposes each available MCA tool as an async function.
 *
 * @returns SandboxResult with output or error
 */
export async function executeSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const {
    code,
    inputData,
    toolExecutor,
    toolCallContext,
    availableTools,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const effectiveTimeout = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  const logs: string[] = [];

  // Build the `tools` object — each tool name becomes an async function
  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolCallResult>> = {};
  for (const toolName of availableTools) {
    tools[toolName] = async (args: Record<string, unknown>) => {
      return toolExecutor.call(toolName, args ?? {}, toolCallContext);
    };
  }

  // Safe console — captures output instead of printing to stdout
  const safeConsole = {
    log: (...args: unknown[]) => { logs.push(args.map(formatLogArg).join(' ')); },
    warn: (...args: unknown[]) => { logs.push('[WARN] ' + args.map(formatLogArg).join(' ')); },
    error: (...args: unknown[]) => { logs.push('[ERROR] ' + args.map(formatLogArg).join(' ')); },
    info: (...args: unknown[]) => { logs.push(args.map(formatLogArg).join(' ')); },
  };

  // Utility functions available to sandbox code
  const utils = {
    // JSON helpers
    parse: (str: string) => JSON.parse(str),
    stringify: (value: unknown, indent?: number) => JSON.stringify(value, null, indent ?? 0),
    // Date helpers
    now: () => new Date().toISOString(),
    // String helpers
    trim: (s: string) => String(s).trim(),
    lower: (s: string) => String(s).toLowerCase(),
    upper: (s: string) => String(s).toUpperCase(),
  };

  // Build the sandbox context object
  // This is what's available to the user code as global variables
  const sandbox = {
    input: inputData,
    tools,
    utils,
    console: safeConsole,
    // Explicitly NOT providing: require, process, global, globalThis,
    // __dirname, __filename, Buffer, setTimeout, setInterval, fetch
  };

  // Create the VM context
  const context = vm.createContext(sandbox, {
    name: 'workflow-function-sandbox',
    codeGeneration: {
      strings: false,  // Disable eval() inside the sandbox
      wasm: false,     // Disable WebAssembly
    },
  });

  // Wrap user code in an async function so `await` works at top level
  // The function receives no arguments — everything is via the sandbox globals
  const wrappedCode = `
    (async () => {
      ${code}
    })();
  `;

  try {
    // Compile the code in the VM context
    const script = new vm.Script(wrappedCode, {
      filename: 'function-node.js',
    });

    // Execute the script — this returns a Promise because of the async wrapper
    const resultPromise = script.runInContext(context, {
      timeout: effectiveTimeout,
      breakOnSigint: true,
    });

    // Wait for the async code to complete
    // We need a separate timeout for the promise since vm timeout only
    // covers synchronous execution
    const output = await Promise.race([
      resultPromise as Promise<unknown>,
      createTimeoutPromise(effectiveTimeout),
    ]);

    return {
      success: true,
      output,
      logs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Distinguish timeout errors from other errors
    if (errorMsg.includes('Script execution timed out') || errorMsg.includes('Sandbox timeout')) {
      return {
        success: false,
        error: `Function node timed out after ${effectiveTimeout}ms. Check for infinite loops or long-running operations.`,
        logs,
      };
    }

    return {
      success: false,
      error: errorMsg,
      logs,
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create a promise that rejects after a timeout.
 * Used to enforce async timeout on sandbox code.
 */
function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Sandbox timeout: execution exceeded time limit'));
    }, timeoutMs);
  });
}

/**
 * Format a value for console output in the sandbox.
 */
function formatLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
