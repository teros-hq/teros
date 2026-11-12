/**
 * AcademyVideoCard — a course tile in the OS prototype's language: a `Card hov`
 * with a rounded thumbnail (play overlay), the title, the objective and a
 * phase Badge. `layout="list"` renders the same content as an LRow. (TER-716)
 */
import { Image, Platform, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import type { AcademyVideo } from "../../data/academyCatalog"
import { youtubeThumbnailUrl } from "../../data/academyCatalog"
import { Badge, Card, LRow, Ph, T } from "../../components/ui/ds"

function Thumbnail({
  youtubeId,
  alt,
  size = "full",
}: {
  youtubeId: string
  alt: string
  size?: "full" | "list"
}) {
  const isList = size === "list"
  return (
    <View
      style={[
        { borderRadius: 12, overflow: "hidden", backgroundColor: "#1A1724", flexShrink: 0 },
        isList ? { width: 150, height: 84 } : { width: "100%", aspectRatio: 16 / 9 },
      ]}
    >
      <Image
        source={{ uri: youtubeThumbnailUrl(youtubeId) }}
        accessibilityLabel={alt}
        accessible
        style={{ width: "100%", height: "100%" }}
        resizeMode="cover"
      />
      {/* Play-button overlay */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={[
            {
              width: isList ? 32 : 44,
              height: isList ? 32 : 44,
              borderRadius: 100,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(26,23,36,0.6)",
            },
            Platform.OS === "web" ? ({ backdropFilter: "blur(4px)" } as any) : null,
          ]}
        >
          <Ph name="play" size={isList ? 14 : 18} color="#FFFFFF" weight="fill" />
        </View>
      </View>
    </View>
  )
}

export function AcademyVideoCard({
  video,
  phaseLabel,
  videoLabel,
  objectiveText,
  layout = "grid",
  onPress,
}: {
  video: AcademyVideo
  phaseLabel: string
  videoLabel: string
  objectiveText: string
  layout?: "grid" | "list"
  onPress: () => void
}) {
  const c = useColors()
  const a11y = `${video.number}. ${video.title}`
  const title = (
    <T step="base" numberOfLines={2}>
      <T step="base" tone="text3">{`${video.number}. `}</T>
      {video.title}
    </T>
  )
  const objective = (
    <T step="sm" tone="text2" numberOfLines={layout === "list" ? 2 : 2}>
      {objectiveText}
    </T>
  )

  if (layout === "list") {
    return (
      <LRow
        onPress={onPress}
        padV={12}
        padH={12}
        gap={14}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        testID={`academy-video-${video.id}`}
      >
        <Thumbnail youtubeId={video.youtubeId} alt={video.title} size="list" />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {title}
          {objective}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 2 }}>
            <Badge mono sm icon="play">
              {videoLabel}
            </Badge>
            <Badge mono sm tone="i">
              {phaseLabel}
            </Badge>
          </View>
        </View>
        <Ph name="caret-right" size={13} color={c.text3} />
      </LRow>
    )
  }

  return (
    <Card
      hov
      onPress={onPress}
      pad={12}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      testID={`academy-video-${video.id}`}
      style={{ height: "100%" }}
    >
      <Thumbnail youtubeId={video.youtubeId} alt={video.title} />
      <View style={{ gap: 6, paddingTop: 12, paddingHorizontal: 4, paddingBottom: 4 }}>
        {title}
        {objective}
        <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
          <Badge mono sm icon="play">
            {videoLabel}
          </Badge>
          <Badge mono sm tone="i">
            {phaseLabel}
          </Badge>
        </View>
      </View>
    </Card>
  )
}
