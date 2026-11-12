/**
 * Onboarding screen — shown once after accepting T&C, before the workspace.
 *
 * Renders the OnboardingWizard fullscreen on the access frame (blobs + frame
 * colour, like login). On completion, replaces to the workspace root so the
 * user lands directly in their first conversation.
 */

import { useRouter } from "expo-router"
import React from "react"
import { View } from "react-native"
import { OnboardingWizard } from "../../../src/components/onboarding/OnboardingWizard"
import { useAuthStore } from "../../../src/store/authStore"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { DriftBlobs } from "../../../src/components/auth/AuthShell"

export default function OnboardingScreen() {
  const router = useRouter()
  const { user } = useAuthStore()
  const c = useColors()

  const handleFinish = () => {
    router.replace("/")
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bgFrame }}>
      <DriftBlobs />
      <OnboardingWizard onFinish={handleFinish} userName={user?.name} />
    </View>
  )
}
