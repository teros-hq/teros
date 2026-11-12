/**
 * `data-fx` hooks for the OS effects layer (see `osEffects.ts`).
 *
 * RN-web maps a `dataSet` prop to `data-*` attributes, but the prop is absent
 * from the RN typings; spread the result of `fx(...)` instead:
 *
 *   <View {...fx("card glow hov")} />
 *   <Card {...fx("hc", { d: "2" })} />
 *
 * On native it is a harmless unknown prop.
 */
export function fx(names: string, extra?: Record<string, string>): Record<string, never> {
  return { dataSet: { fx: names, ...extra } } as unknown as Record<string, never>
}
