/**
 * Clock — inyección del tiempo para hacer deterministas los tests.
 *
 * En producción `SystemClock` (`Date.now()`). En tests deterministas
 * `FixedClock` congela (o avanza de forma controlada) el instante.
 *
 * Superficie MÍNIMA a propósito: solo `now(): number`. El único punto que
 * necesita un tiempo determinista es el timestamp del `[Current Context]` que
 * el prompt inyecta como mensaje hasheado por el replay (TurnDriver). NO es un
 * reloj global del backend — el resto del sistema sigue usando `Date.now()`
 * real (timestamps de mensajes, TTLs, throttles). TER-563.
 */
export interface Clock {
  /** Epoch en milisegundos, espejo de `Date.now()`. */
  now(): number;
}

/** Reloj de producción: el reloj real del sistema. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Reloj determinista para replay/record. Congelado por defecto (`stepMs = 0`);
 * con `stepMs > 0` avanza monotónicamente por llamada. Para el hash del
 * `[Current Context]` interesa un instante fijo (stepMs = 0).
 */
export class FixedClock implements Clock {
  private current: number;

  constructor(
    epochMs: number,
    private readonly stepMs = 0,
  ) {
    this.current = epochMs;
  }

  now(): number {
    const t = this.current;
    this.current += this.stepMs;
    return t;
  }
}
