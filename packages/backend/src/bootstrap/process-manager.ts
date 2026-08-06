/**
 * Process-manager readiness signal (TER-418).
 *
 * `ecosystem.prod.config.cjs` declara `wait_ready: true` + `listen_timeout: 10000`:
 * PM2 espera una señal `ready` por el canal IPC antes de dar el proceso por
 * arrancado. Hasta ahora esa señal NUNCA se enviaba (0 llamadas a `process.send`
 * en el backend), así que PM2 agotaba el `listen_timeout` completo (10 s) en CADA
 * restart antes de marcar el proceso online — 10 s de "readiness" fantasma en
 * cada deploy, y un readiness que no refleja el estado real del server.
 *
 * `process.send` solo existe cuando el proceso se forkeó con un canal IPC (PM2,
 * cluster mode). En standalone (`tsx src/index.ts` en local/test) es undefined,
 * así que el optional-chaining evita un crash al arrancar fuera de PM2.
 */

/**
 * Señala al process manager (PM2) que el backend está listo para recibir
 * tráfico. Llamar UNA vez, desde el callback de `httpServer.listen()` — cuando el
 * server ya acepta conexiones. No-op si no hay canal IPC.
 */
export function notifyProcessManagerReady(proc: Pick<NodeJS.Process, 'send'> = process): void {
  proc.send?.('ready')
}
