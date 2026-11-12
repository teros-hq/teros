/**
 * StepHeader — Reusable serif title + lead for onboarding steps.
 */

import React from "react"
import { View } from "react-native"
import { T } from "../ui/ds"

interface StepHeaderProps {
  title: string
  description: string
}

export function StepHeader({ title, description }: StepHeaderProps) {
  return (
    <View style={{ gap: 6 }}>
      <T step="xl">{title}</T>
      <T step="sm" tone="text2" style={{ lineHeight: 19 }}>
        {description}
      </T>
    </View>
  )
}
