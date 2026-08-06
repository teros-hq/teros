/**
 * Session lifecycle types
 *
 * Contrato que todo store con estado de sesión debe implementar.
 * Garantiza que el SessionManager puede limpiar cualquier store
 * sin conocer su implementación interna.
 */

/**
 * Devuelve el store a su estado inicial (como si la app acabara de arrancar).
 * Debe limpiar tanto el estado en memoria como cualquier key de storage
 * que el store haya escrito.
 */
export interface Resettable {
  resetSession(): void | Promise<void>
}
