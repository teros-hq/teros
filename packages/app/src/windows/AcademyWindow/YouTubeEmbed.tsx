/**
 * YouTubeEmbed — 16:9 responsive YouTube player.
 * Web: <iframe>. Native: react-native-webview. (TER-716)
 */
import { Platform, View } from "react-native"
import { WebView } from "react-native-webview"
import { youtubeEmbedUrl } from "../../data/academyCatalog"

const FRAME = {
  width: "100%" as const,
  aspectRatio: 16 / 9,
  backgroundColor: "#1A1724",
  borderRadius: 16,
  overflow: "hidden" as const,
}

export function YouTubeEmbed({ youtubeId, title }: { youtubeId: string; title: string }) {
  const src = youtubeEmbedUrl(youtubeId)

  if (Platform.OS === "web") {
    return (
      <View style={FRAME}>
        <iframe
          src={src}
          title={title}
          style={{ border: "none", width: "100%", height: "100%", display: "block" }}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </View>
    )
  }

  return (
    <View style={FRAME}>
      <WebView
        source={{ uri: src }}
        allowsFullscreenVideo
        style={{ flex: 1, backgroundColor: "#1A1724" }}
      />
    </View>
  )
}
