import { createHash, randomBytes } from 'crypto';

/**
 * IdGenerator — inyección de la generación de IDs para tests deterministas.
 *
 * Genera el cuerpo `<hex16>` de un id con forma `<prefix>_<hex16>`. En
 * producción `RandomIdGenerator` (`crypto.randomBytes`). En tests deterministas
 * `SeededIdGenerator` produce una secuencia reproducible.
 *
 * Hace deterministas los IDs que terminan dentro del input hasheado por el
 * replay del LLM — en la práctica el `channelId` del `[Current Context]`. El
 * resto de IDs del sistema siguen siendo aleatorios salvo que se inyecte el
 * generador determinista (solo en modo test). TER-563.
 */
export interface IdGenerator {
  /** 16 caracteres hex en minúscula (8 bytes de entropía). */
  hex16(): string;
  /** Deriva un generador con secuencia propia para un sub-dominio (p.ej. 'ch',
   *  'msg'). Para el generador aleatorio es un no-op (devuelve sí mismo). */
  fork(namespace: string): IdGenerator;
}

/** Generador de producción: aleatorio criptográfico. */
export class RandomIdGenerator implements IdGenerator {
  hex16(): string {
    return randomBytes(8).toString('hex');
  }
  fork(): IdGenerator {
    return this;
  }
}

/**
 * Generador determinista con namespaces. NO es un contador global: cada
 * namespace lleva su propia secuencia, de modo que el n-ésimo id de un
 * namespace es siempre el mismo, sin acoplarse a cuántos ids de OTROS
 * namespaces se pidieron antes. `fork(ns)` deriva un generador aislado para un
 * sub-dominio (p.ej. uno por prefijo: 'ch', 'msg').
 *
 * El valor es `sha256(seed:namespace:n).slice(0,16)` — estable entre procesos
 * para el mismo `(seed, namespace, n)` y, dentro de un namespace, monótono y
 * sin colisiones.
 */
export class SeededIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(
    private readonly seed: string,
    private readonly namespace = 'default',
  ) {}

  hex16(): string {
    const n = this.counter++;
    return createHash('sha256')
      .update(`${this.seed}:${this.namespace}:${n}`)
      .digest('hex')
      .slice(0, 16);
  }

  /** Deriva un generador con su propia secuencia para un sub-dominio. */
  fork(namespace: string): SeededIdGenerator {
    return new SeededIdGenerator(this.seed, namespace);
  }
}
