/** The kit's page card a file preview sits on, and the quiet tile for files without a preview. */
import React from "react"
import { View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { Tx } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { extOf } from "./io"

export function usePageStyle(): ViewStyle[] {
  const td = useTd()
  return [
    { width: "100%", aspectRatio: 210 / 297, backgroundColor: td.paper, borderRadius: 3, overflow: "hidden" },
    web({
      boxShadow: "0 1px 2px rgba(32,28,39,.10), 0 18px 36px -18px rgba(32,28,39,.5)",
      transition: "transform .35s cubic-bezier(.16,1,.3,1), box-shadow .35s cubic-bezier(.16,1,.3,1)",
    }) as ViewStyle,
  ]
}

export function FileTile({ name }: { name: string }) {
  const page = usePageStyle()
  return (
    <View style={[...page, { aspectRatio: undefined, height: 180, alignItems: "center", justifyContent: "center", gap: 8 }]}>
      <Ph name="file" size={28} color="#968FA7" />
      <Tx f="mono" s={11} lh={14} c="#797386">
        {extOf(name)}
      </Tx>
    </View>
  )
}
