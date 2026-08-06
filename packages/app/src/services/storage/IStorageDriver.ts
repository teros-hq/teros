/**
 * IStorageDriver
 *
 * Contrato mínimo para todos los drivers de almacenamiento.
 * Los consumers dependen de esta interfaz, nunca de implementaciones concretas.
 */
export interface IStorageDriver {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}
