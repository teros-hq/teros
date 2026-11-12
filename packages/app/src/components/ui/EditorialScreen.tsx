/**
 * EditorialScreen — the shared editorial card (pretty 404 / root-resolver failure)
 *
 * One visual pattern, two screens:
 *   - app/+not-found.tsx (pretty 404): code "404", "go to start" action.
 *   - app/(workspace)/index.tsx (root resolver failure): no code, "retry".
 *
 * Design (OS prototype, Oct 2026): the access frame — frame colour with the
 * drifting colour blobs — and one centred card (radius 24) holding the brand,
 * a big serif code, the title, a lead and one primary pill. Shares AuthShell
 * with the login family so the two cannot drift apart.
 */

import React from "react"
import { View } from "react-native"
import { AuthBrand, AuthShell } from "../auth/AuthShell"
import { Btn, T } from "./ds"

export interface EditorialScreenProps {
  /** Big serif marker above the title (e.g. "404"). Optional — screens with
   *  no meaningful code (the root resolver) omit it and keep the card rhythm
   *  via the title's top margin. */
  code?: string
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}

export function EditorialScreen({
  code,
  title,
  description,
  actionLabel,
  onAction,
}: EditorialScreenProps) {
  return (
    <AuthShell footer testID="editorial-screen">
      <AuthBrand />

      {code ? (
        <T step="4xl" tone="text3" style={{ marginBottom: 10 }}>
          {code}
        </T>
      ) : (
        // Keep the 404's vertical rhythm when there is no serif code line.
        <View style={{ height: 18 }} />
      )}

      <T step="xl">{title}</T>
      <T step="sm" tone="text2" style={{ marginTop: 10, lineHeight: 19 }}>
        {description}
      </T>

      <View style={{ flexDirection: "row", marginTop: 26 }}>
        <Btn
          variant="primary"
          size="lg"
          icon="arrow-right"
          onPress={onAction}
          testID="editorial-action"
        >
          {actionLabel}
        </Btn>
      </View>
    </AuthShell>
  )
}
