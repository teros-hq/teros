/**
 * Onboarding screen — shown once after accepting T&C, before the workspace.
 *
 * Renders the OnboardingWizard fullscreen. On completion, replaces to the
 * workspace root so the user lands directly in their first conversation.
 */

import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import React from 'react'
import { OnboardingWizard } from '../../../src/components/onboarding/OnboardingWizard'
import { useAuthStore } from '../../../src/store/authStore'
import { useColors } from "../../../src/components/mca/primitives/useColors"

export default function OnboardingScreen() {
  const router = useRouter()
  const { user } = useAuthStore()
  const c = useColors()

  const handleFinish = () => {
    router.replace('/')
  }

  return (
    <LinearGradient
      colors={[c.bgPage, c.bgCard, c.bgPage]}
      locations={[0, 0.5, 1]}
      style={{ flex: 1 }}
    >
      <OnboardingWizard
        onFinish={handleFinish}
        userName={user?.name}
      />
    </LinearGradient>
  )
}
