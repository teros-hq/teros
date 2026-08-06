/**
 * Agent-facing tool-execution proxy — meta-tool definitions.
 *
 * Three synthetic tools injected by McaToolExecutor into every conversation,
 * so the LLM can discover and execute app tools on demand instead of having
 * every installed app's tools preloaded in its context window
 *.
 *
 * Naming invariant: meta-tool names contain NO underscore. Real app tools are
 * always namespaced `${appName}_${tool}`, so a collision is impossible by
 * construction (TurnDriver.assertNoDuplicateToolNames).
 *
 * These definitions are descriptions only — the handlers live in
 * McaToolExecutor, which intercepts these names before the permission gate.
 * The two list tools are local reads (always allowed, like private tools);
 * `execute-tool` is permission-transparent: the gate runs for the TARGET tool.
 */

import { PROXY_TOOL_NAMES } from "@teros/shared"
import type { ToolDefinition } from "./mca-manager.types"

// Canonical names live in @teros/shared (the chat UI special-cases them too).
export const PROXY_TOOL_LIST_APPS = PROXY_TOOL_NAMES.listInstalledApps
export const PROXY_TOOL_LIST_APP_TOOLS = PROXY_TOOL_NAMES.listAppTools
export const PROXY_TOOL_EXECUTE = PROXY_TOOL_NAMES.execute

const PROXY_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  PROXY_TOOL_LIST_APPS,
  PROXY_TOOL_LIST_APP_TOOLS,
  PROXY_TOOL_EXECUTE,
])

export function isProxyTool(toolName: string): boolean {
  return PROXY_TOOL_NAME_SET.has(toolName)
}

/**
 * Discovery is invisible in the chat UI (list calls render as nothing and
 * execute-tool tunnels to the target's renderer), so any narration between
 * these calls reads as the agent talking to itself. Baked into every
 * meta-tool description.
 */
const SILENT_CHAINING =
  " Chain these meta-tool calls silently: do not write any user-facing text between " +
  "discovery calls and the execution — speak only about the final outcome."

/**
 * Definitions handed to the LLM alongside the (direct-exposure) app tools.
 * Kept as a function to avoid shared mutable state between executors.
 *
 * `installedAppsSummary` (one stable line per app: name, description, tool
 * count — deliberately NO volatile status, which would bust the prompt cache
 * mid-conversation) is baked into the execute-tool description so the agent
 * knows its apps without a discovery round-trip. Fresh status/exposure detail
 * stays behind list-installed-apps.
 */
export function buildProxyToolDefinitions(installedAppsSummary?: string): ToolDefinition[] {
  return [
    {
      name: PROXY_TOOL_LIST_APPS,
      description:
        "List the apps installed for you, with a short description, LIVE status (ready/standby/error/disabled), " +
        "tool count and exposure for each. Your installed apps are already summarized in the " +
        `${PROXY_TOOL_EXECUTE} description — call this only when you need current status or suspect the list changed.` +
        SILENT_CHAINING,
      input_schema: {
        type: "object",
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: PROXY_TOOL_LIST_APP_TOOLS,
      description:
        "List the tools an installed app provides. By default returns a compact list: tool name, description " +
        "and permission flags. Pass `tools` with specific tool names to also get their full input schemas — " +
        `do that before calling ${PROXY_TOOL_EXECUTE} for a tool whose parameters you do not know.` +
        SILENT_CHAINING,
      input_schema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: `App name or appId, as returned by ${PROXY_TOOL_LIST_APPS}.`,
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Optional: tool names to expand with their full input schemas.",
          },
        },
        required: ["app"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: PROXY_TOOL_EXECUTE,
      description:
        "Execute a tool of an installed app by name. Use this for apps whose tools are not in your tool list. " +
        `Get the tool's input schema first via ${PROXY_TOOL_LIST_APP_TOOLS} with \`tools: [name]\`. ` +
        "Permissions apply exactly as if you called the tool directly: the user may be asked to confirm, " +
        "and forbidden tools stay forbidden." +
        SILENT_CHAINING +
        (installedAppsSummary ? `\n\nYour installed apps:\n${installedAppsSummary}` : ""),
      input_schema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: `App name or appId, as returned by ${PROXY_TOOL_LIST_APPS}.`,
          },
          tool: {
            type: "string",
            description: `Tool name within the app, as returned by ${PROXY_TOOL_LIST_APP_TOOLS}.`,
          },
          input: {
            type: "object",
            description:
              "The tool's input, matching its input schema. Omit for tools without parameters.",
          },
        },
        required: ["app", "tool"],
      },
      // Mutation by default: the target tool decides what actually happens,
      // and the permission gate runs for the target — this hint is only
      // descriptive so nothing ever auto-allows the proxy wholesale.
      annotations: { readOnlyHint: false },
    },
  ]
}
