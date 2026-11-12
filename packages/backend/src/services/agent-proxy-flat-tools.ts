/**
 * Flat tool-call format — PRUEBA para evitar corrupción JSON-anidado.
 *
 * En vez de que el LLM llame execute-tool con input como objeto anidado:
 *   execute-tool({ app: "remote-napoli", tool: "bash", input: { command: "ls" } })
 *
 * Generamos tools virtuales planas:
 *   remote_napoli_bash({ command: "ls", description: "list files" })
 *
 * Ventajas:
 * - Sin JSON dentro de JSON → sin escapes triples
 * - Schema plano → GLM/LLMs rápidos no se lían
 * - Cada tool virtual tiene su propio schema específico
 *
 * Esta es una PRUEBA — se puede revertir fácilmente.
 */

import type { ToolDefinition } from "./mca-manager.types"

/**
 * Sanitiza un nombre para usarlo como nombre de tool válido.
 * Reemplaza guiones por underscores y elimina caracteres no válidos.
 */
function sanitizeToolName(name: string): string {
  return name.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "")
}

/**
 * Genera el nombre de la tool virtual plana.
 * Formato: {appName}_{toolName} (sanitizado)
 */
// @fixme nira - 2026.10.22 : buildFlatToolName no detecta colisiones — si el flat
// name colisiona con un nombre real (app 'bash' + tool 'bash' → 'bash_bash' ===
// namespaced 'bash_bash'), hoy el guard de mca-tool-executor degrada la llamada al
// path normal; lo robusto sería renombrar (p.ej. 'bash_bash_flat') o rechazar el
// registro con log de aviso, para que el formato flat sea predecible.
// Incidente: docs/incidents/20261022_bash-flat-toolcalls-recursion.md
export function buildFlatToolName(appName: string, toolName: string): string {
  const app = sanitizeToolName(appName)
  const tool = sanitizeToolName(toolName)
  return `${app}_${tool}`
}

/**
 * Información de una app para generar sus tools planas.
 */
export interface FlatAppInfo {
  appId: string
  appName: string
  mcaId: string
  tools: Array<{
    name: string
    description: string
    inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] }
  }>
}

/**
 * Genera tools virtuales planas para una app.
 *
 * Cada tool de la app se convierte en una tool virtual con:
 * - Nombre: {appName}_{toolName}
 * - Schema: plano (los campos del input original se promueven al top level)
 * - Descripción: incluye referencia a la app original
 */
export function buildFlatToolDefinitions(appInfo: FlatAppInfo): ToolDefinition[] {
  const flatTools: ToolDefinition[] = []

  for (const tool of appInfo.tools) {
    const flatName = buildFlatToolName(appInfo.appName, tool.name)
    
    // Extraer propiedades del schema de input original
    const originalProps = tool.inputSchema?.properties || {}
    const originalRequired = tool.inputSchema?.required || []
    
    // Construir schema plano
    const flatSchema: { type: "object"; properties: Record<string, any>; required?: string[] } = {
      type: "object",
      properties: {
        // Copiar todas las propiedades originales al top level
        ...originalProps,
      },
      required: [...originalRequired],
    }
    
    // Añadir descripción con contexto de la app
    const flatDescription = 
      `[${appInfo.appName}] ${tool.description}\n\n` +
      `Esta es una tool plana de la app '${appInfo.appName}'. ` +
      `Los parámetros van directamente, sin objeto 'input' anidado.`
    
    flatTools.push({
      name: flatName,
      description: flatDescription,
      input_schema: flatSchema,
      annotations: { readOnlyHint: false },
    })
  }

  return flatTools
}

/**
 * Parsea el nombre de una tool plana para extraer app y tool original.
 * Formato esperado: {appName}_{toolName}
 *
 * Retorna null si no es una tool plana válida.
 */
export function parseFlatToolName(flatName: string): { appName: string; toolName: string } | null {
  // Buscar el primer underscore que separa app de tool
  // Esto es ambiguo si appName contiene underscores, así que usamos
  // una convención: el appName es todo hasta el ÚLTIMO segmento que
  // coincide con un appName conocido. Para simplificar, asumimos que
  // el formato es app_tool donde app no contiene underscores después
  // de sanitización (los guiones se convierten en underscores).
  
  // Mejor enfoque: mantener un registro de tools planas generadas
  // Por ahora, retornamos null y usamos un registry externo
  return null
}

/**
 * Registry de tools planas para mapeo inverso.
 * Se construye al generar las tools y se usa al ejecutar.
 */
export class FlatToolRegistry {
  private flatToOriginal: Map<string, { appId: string; appName: string; toolName: string }> = new Map()
  
  register(flatName: string, appId: string, appName: string, toolName: string): void {
    this.flatToOriginal.set(flatName, { appId, appName, toolName })
  }
  
  resolve(flatName: string): { appId: string; appName: string; toolName: string } | null {
    return this.flatToOriginal.get(flatName) || null
  }
  
  has(flatName: string): boolean {
    return this.flatToOriginal.has(flatName)
  }
  
  clear(): void {
    this.flatToOriginal.clear()
  }
}
