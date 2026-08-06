/**
 * Error Catalog — centralized mapping from raw error patterns to
 * user-friendly messages with classification metadata.
 *
 * Used by backend (agent-loop, websocket handler) and frontend (fallback)
 * to ensure no raw technical error reaches the end user.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorType = 'llm' | 'tool' | 'session' | 'validation' | 'network' | 'unknown'

export interface ErrorPattern {
  id: string
  match: (err: { message: string; code?: string; name?: string; statusCode?: number }) => boolean
  errorType: ErrorType
  i18nKey: string
  defaultMessage: string
  recoverable: boolean
}

export interface NormalizedError {
  errorType: ErrorType
  userMessage: string
  i18nKey: string
  technicalMessage: string
  recoverable: boolean
  patternId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msgOrCode(err: { message: string; code?: string; name?: string }, pattern: RegExp): boolean {
  return (
    pattern.test(err.message) ||
    (err.code != null && pattern.test(err.code)) ||
    (err.name != null && pattern.test(err.name))
  )
}

// ---------------------------------------------------------------------------
// Catalog (first-match wins — most specific first)
// ---------------------------------------------------------------------------

export const ERROR_CATALOG: ErrorPattern[] = [
  // --- Network / connectivity ---
  {
    id: 'MONGO_CONN_REFUSED',
    match: (e) => /ECONNREFUSED/i.test(e.message) && /27017/.test(e.message),
    errorType: 'network',
    i18nKey: 'errors.normalized.mongoConnectionRefused',
    defaultMessage: 'Estamos teniendo problemas de conexión con la base de datos. Por favor, intenta de nuevo en unos segundos.',
    recoverable: true,
  },
  {
    id: 'CONN_REFUSED',
    match: (e) => msgOrCode(e, /ECONNREFUSED/i),
    errorType: 'network',
    i18nKey: 'errors.normalized.connectionRefused',
    defaultMessage: 'No se puede conectar al servicio. Intenta de nuevo en unos segundos.',
    recoverable: true,
  },
  {
    id: 'CONN_RESET',
    match: (e) => msgOrCode(e, /ECONNRESET/i),
    errorType: 'network',
    i18nKey: 'errors.normalized.connectionReset',
    defaultMessage: 'La conexión se interrumpió. Intenta de nuevo.',
    recoverable: true,
  },
  {
    id: 'DNS_RESOLUTION',
    match: (e) => msgOrCode(e, /ENOTFOUND|EAI_AGAIN/i),
    errorType: 'network',
    i18nKey: 'errors.normalized.dnsResolution',
    defaultMessage: 'No se puede resolver la dirección del servicio. Verifica tu conexión.',
    recoverable: true,
  },
  {
    id: 'TIMEOUT',
    match: (e) => msgOrCode(e, /ETIMEDOUT|TimeoutError/i) || /\btimed?\s?out\b/i.test(e.message),
    errorType: 'network',
    i18nKey: 'errors.normalized.timeout',
    defaultMessage: 'La operación tardó demasiado. Intenta de nuevo.',
    recoverable: true,
  },

  // --- Auth / session ---
  {
    id: 'AUTH_EXPIRED',
    match: (e) =>
      /token.*(expired|invalid)|expired.*token|OAuth.*error|MCA_CALLBACK_TOKEN/i.test(e.message) ||
      e.statusCode === 401,
    errorType: 'session',
    i18nKey: 'errors.normalized.authExpired',
    defaultMessage: 'Tu sesión ha expirado. Reconéctate para continuar.',
    recoverable: false,
  },

  // --- Filesystem ---
  {
    id: 'PERMISSION_DENIED',
    match: (e) => msgOrCode(e, /EACCES|EPERM/i) || /\bforbidden\b/i.test(e.message),
    errorType: 'validation',
    i18nKey: 'errors.normalized.permissionDenied',
    defaultMessage: 'No tienes permisos para realizar esta acción.',
    recoverable: false,
  },
  {
    id: 'FILE_NOT_FOUND',
    match: (e) => msgOrCode(e, /ENOENT/i),
    errorType: 'validation',
    i18nKey: 'errors.normalized.fileNotFound',
    defaultMessage: 'No se encontró el archivo solicitado.',
    recoverable: false,
  },

  // --- Parsing ---
  {
    id: 'JSON_PARSE',
    match: (e) =>
      /SyntaxError|Unexpected token|JSON\.parse|JSON.*at position/i.test(e.message),
    errorType: 'validation',
    i18nKey: 'errors.normalized.jsonParse',
    defaultMessage: 'Error al procesar la respuesta. Intenta de nuevo.',
    recoverable: true,
  },

  // --- LLM ---
  {
    id: 'CONTEXT_WINDOW',
    match: (e) =>
      /prompt is too long|context_length|tokens\s*>/i.test(e.message) ||
      e.statusCode === 413,
    errorType: 'llm',
    i18nKey: 'errors.normalized.contextWindow',
    defaultMessage: 'La conversación es demasiado larga. Se activará compactación automática.',
    recoverable: true,
  },
  {
    id: 'RATE_LIMIT',
    match: (e) => /rate.?limit/i.test(e.message) || e.statusCode === 429,
    errorType: 'llm',
    i18nKey: 'errors.normalized.rateLimit',
    defaultMessage: 'Límite de uso alcanzado. Intenta en unos minutos.',
    recoverable: true,
  },
  {
    id: 'LLM_SERVER_ERROR',
    match: (e) =>
      (e.statusCode != null && e.statusCode >= 500) ||
      /server error|internal.*error.*5\d{2}/i.test(e.message),
    errorType: 'llm',
    i18nKey: 'errors.normalized.llmServerError',
    defaultMessage: 'El servicio de IA no está disponible temporalmente. Intenta de nuevo.',
    recoverable: true,
  },

  // --- Tool ---
  {
    id: 'TOOL_UNAVAILABLE',
    match: (e) =>
      /tool.?not.?found|NOT_READY|MCA.*not available|mca.*crashed/i.test(e.message),
    errorType: 'tool',
    i18nKey: 'errors.normalized.toolUnavailable',
    defaultMessage: 'La herramienta no está disponible en este momento. Intenta de nuevo.',
    recoverable: true,
  },

  // --- Fallback (always matches) ---
  {
    id: 'FALLBACK',
    match: () => true,
    errorType: 'unknown',
    i18nKey: 'errors.normalized.unknown',
    defaultMessage: 'Ocurrió un error inesperado. Intenta de nuevo.',
    recoverable: true,
  },
]

// ---------------------------------------------------------------------------
// User-facing errors
// ---------------------------------------------------------------------------

/**
 * Contrato estructural para errores que YA traen un mensaje redactado para el
 * usuario final — p.ej. `AgentError` (core, `.userMessage`) o `HandlerError`
 * (backend, `.userMessage`). `normalizeError` respeta ese mensaje en vez de
 * sustituirlo por el del catálogo, que está pensado solo para errores crudos
 * de infraestructura.
 *
 * Se detecta por duck-typing a propósito: `@teros/shared` está por debajo de
 * `@teros/core` y del backend, así que no puede importar esas clases. El
 * contrato (una propiedad `userMessage` no vacía) las cubre a todas sin acoplar
 * capas y sin que cada punto de fuga (agent-loop, WsRouter, websocket-handler)
 * tenga que repetir el `instanceof` — la decisión vive en un único sitio.
 */
export interface UserFacingError {
  readonly userMessage: string
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { userMessage?: unknown }).userMessage === 'string' &&
    (error as { userMessage: string }).userMessage.trim().length > 0
  )
}

// ---------------------------------------------------------------------------
// normalizeError
// ---------------------------------------------------------------------------

export function normalizeError(error: unknown): NormalizedError {
  const { message, code, name, statusCode } = extractErrorInfo(error)

  const pattern = ERROR_CATALOG.find((p) => p.match({ message, code, name, statusCode }))!

  return {
    errorType: pattern.errorType,
    // Si el error ya expone un mensaje user-facing (AgentError, HandlerError),
    // se respeta — la aplicación ya lo redactó para el usuario. El catálogo
    // solo sustituye el mensaje de los errores crudos de infraestructura.
    userMessage: isUserFacingError(error) ? error.userMessage : pattern.defaultMessage,
    i18nKey: pattern.i18nKey,
    technicalMessage: message,
    recoverable: pattern.recoverable,
    patternId: pattern.id,
  }
}

function extractErrorInfo(error: unknown): {
  message: string
  code?: string
  name?: string
  statusCode?: number
} {
  if (error == null) {
    return { message: 'Unknown error' }
  }

  if (typeof error === 'string') {
    return { message: error }
  }

  if (typeof error === 'object') {
    const e = error as Record<string, any>
    const message =
      typeof e.message === 'string' ? e.message : String(error)
    const code = typeof e.code === 'string' ? e.code : undefined
    const name = typeof e.name === 'string' ? e.name : undefined
    const statusCode =
      typeof e.status === 'number'
        ? e.status
        : typeof e.statusCode === 'number'
          ? e.statusCode
          : undefined
    return { message, code, name, statusCode }
  }

  return { message: String(error) }
}
