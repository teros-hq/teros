/**
 * Thin wrapper over `app.execute-tool` for the todo-list MCA: parses the
 * result and turns a failed call into a TodoError carrying the backend code
 * (the thin client formats errors as "[CODE] message suggestion").
 */
import { getTerosClient } from "../../../services/terosClientSingleton"

export class TodoError extends Error {
  code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.code = code
  }
}

function parse<T>(raw: unknown): T {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as unknown as T
    }
  }
  return raw as T
}

function errorOf(raw: unknown): TodoError {
  let text = typeof raw === "string" ? raw : ""
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    text = String(o.message ?? o.error ?? "")
    if (typeof o.code === "string") return new TodoError(text || o.code, o.code)
  }
  if (text.startsWith("Error: ")) text = text.slice(7)
  const m = /^\[([A-Z_]+)\]\s*(.*)$/s.exec(text.trim())
  if (m) return new TodoError(m[2], m[1])
  return new TodoError(text || "Tool execution failed", null)
}

export async function callTodo<T = any>(appId: string, tool: string, input: Record<string, unknown> = {}): Promise<T> {
  const client = getTerosClient()
  const res = await client.executeTool<unknown>(appId, tool, input)
  if (!res.success) throw errorOf(res.result)
  return parse<T>(res.result)
}
