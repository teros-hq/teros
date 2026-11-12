/** A quiet error line at the bottom of a To Do window; hides after a few seconds. */
import React, { useEffect } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { Tx } from "./kit"
import { web } from "./todoFx"
import { useTd } from "./tokens"

export function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  const td = useTd()
  useEffect(() => {
    const timer = setTimeout(onClose, 5000)
    return () => clearTimeout(timer)
  }, [message, onClose])
  return (
    <View style={{ position: "absolute", left: 12, right: 12, bottom: 12, alignItems: "center", zIndex: 90 }} pointerEvents="box-none">
      <View
        accessibilityRole="alert"
        style={[
          { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 520, paddingVertical: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 12, backgroundColor: td.card },
          web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
        ]}
      >
        <Ph name="warning-circle" size={14} color={td.rTx} />
        <Tx s={12.5} lh={18} c={td.text} style={{ flexShrink: 1 }}>
          {message}
        </Tx>
        <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 4 }}>
          <Ph name="x" size={12} color={td.text3} />
        </Pressable>
      </View>
    </View>
  )
}
