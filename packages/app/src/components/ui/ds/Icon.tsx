/**
 * Ph — Phosphor icon (native). Resolves the kebab-case name against
 * `phosphor-react-native` (`magnifying-glass` → `MagnifyingGlassIcon`).
 * Web resolves `./Icon.web.tsx` (font glyphs, like the prototype).
 */
import React from "react"
import * as Phosphor from "phosphor-react-native"
import { View } from "react-native"
import type { PhProps } from "./Icon.types"

function toPascal(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")
}

export function Ph({ name, size = 16, color = "#968FA7", weight = "regular", style }: PhProps) {
  const pascal = toPascal(name)
  const lib = Phosphor as unknown as Record<string, React.ComponentType<any>>
  const Cmp = lib[`${pascal}Icon`] ?? lib[pascal]
  if (!Cmp) return <View style={[{ width: size, height: size }, style]} />
  return (
    <View
      style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}
    >
      <Cmp size={size} color={color} weight={weight} />
    </View>
  )
}
