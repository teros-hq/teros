/**
 * Academy Window Content (TER-716)
 * Switches between catalog and detail sub-views via local state.
 */
import { useState } from "react"
import { View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { AcademyCatalog } from "./AcademyCatalog"
import { AcademyDetail } from "./AcademyDetail"
import type { AcademyWindowProps } from "./definition"

interface AcademyWindowContentProps extends AcademyWindowProps {
  windowId: string
}

export function AcademyWindowContent({ windowId }: AcademyWindowContentProps) {
  const c = useColors()
  const [view, setView] = useState<"catalog" | "detail">("catalog")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const openDetail = (videoId: string) => {
    setSelectedId(videoId)
    setView("detail")
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      {view === "catalog" ? (
        <AcademyCatalog onSelectVideo={openDetail} />
      ) : (
        <AcademyDetail
          videoId={selectedId!}
          onBack={() => setView("catalog")}
          onNavigate={openDetail}
        />
      )}
    </View>
  )
}
