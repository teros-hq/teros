/**
 * ToolCallMetaContext — the identity of the tool call a renderer is drawing.
 *
 * Provided by `withPermissionSupport` (which `McaRegistry` applies to every
 * renderer, pending or not) so the `HeaderRow` can show the tool name in its
 * mono pill (`gmail.send_email`) without each of the ~120 renderers having to
 * thread `toolName` into `ToolCallCard` by hand. An explicit `toolName` prop
 * on the card/header still wins over the context.
 */
import { createContext, useContext } from "react"

export interface ToolCallMeta {
  toolName?: string
  mcaId?: string
  appId?: string
  /** The call's input — the chip picks its headline argument from it. */
  input?: Record<string, unknown>
}

export const ToolCallMetaContext = createContext<ToolCallMeta | null>(null)

export function useToolCallMeta(): ToolCallMeta | null {
  return useContext(ToolCallMetaContext)
}
