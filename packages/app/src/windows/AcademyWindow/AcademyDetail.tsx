/**
 * AcademyDetail — player + objective/steps/transcript + back / prev / next.
 * OS prototype language: ghost back pill, EN/ES Segmented, prev/next pills,
 * a Card for the player and SectionLabels for the text blocks. (TER-716)
 */
import { useState } from "react"
import { View } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  ACADEMY_VIDEOS,
  getAdjacentVideos,
  getPhase,
  localize,
  localizeSteps,
  resolveContentLang,
  type ContentLang,
} from "../../data/academyCatalog"
import { YouTubeEmbed } from "./YouTubeEmbed"
import { Badge, Btn, EmptyState, Page, SectionLabel, Segmented, T } from "../../components/ui/ds"

export function AcademyDetail({
  videoId,
  onBack,
  onNavigate,
}: {
  videoId: string
  onBack: () => void
  onNavigate: (videoId: string) => void
}) {
  const c = useColors()
  const { t, i18n } = useTranslation()
  // Content language: initialized from the UI language; toggled locally per detail view.
  const [lang, setLang] = useState<ContentLang>(resolveContentLang(i18n.language))
  const video = ACADEMY_VIDEOS.find((v) => v.id === videoId)
  if (!video) {
    return (
      <Page narrow>
        <EmptyState
          title={t("academy.noResults")}
          action={
            <Btn variant="sec" icon="arrow-left" onPress={onBack}>
              {t("academy.back")}
            </Btn>
          }
        />
      </Page>
    )
  }
  const phase = getPhase(video.phase)
  const { prev, next } = getAdjacentVideos(video.id)

  return (
    <Page narrow>
      {/* Top bar: back + content-language toggle + prev/next */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <Btn
          variant="ghost"
          icon="arrow-left"
          onPress={onBack}
          accessibilityLabel={t("academy.back")}
          testID="academy-back"
        >
          {t("academy.back")}
        </Btn>
        <View style={{ flex: 1 }} />
        {/* EN/ES content-language toggle (segmented control) */}
        <View accessibilityLabel={t("academy.contentLanguage")}>
          <Segmented
            value={lang}
            onChange={setLang}
            items={(["en", "es"] as ContentLang[]).map((l) => ({ key: l, label: l.toUpperCase() }))}
            style={{ width: 110 }}
          />
        </View>
        <Btn
          variant="sec"
          icon="caret-left"
          disabled={!prev}
          onPress={() => prev && onNavigate(prev.id)}
          accessibilityLabel={t("academy.previous")}
          testID="academy-prev"
        >
          {t("academy.previous")}
        </Btn>
        <Btn
          variant="sec"
          iconRight="caret-right"
          disabled={!next}
          onPress={() => next && onNavigate(next.id)}
          accessibilityLabel={t("academy.next")}
          testID="academy-next"
        >
          {t("academy.next")}
        </Btn>
      </View>

      <YouTubeEmbed youtubeId={video.youtubeId} title={video.title} />

      <View style={{ gap: 10, marginTop: 24, marginBottom: 8 }}>
        {phase ? (
          <View style={{ flexDirection: "row" }}>
            <Badge tone="i" pill>
              {phase.title}
            </Badge>
          </View>
        ) : null}
        <T step="3xl">
          <T step="3xl" tone="text3">{`#${video.number} `}</T>
          {video.title}
        </T>
      </View>

      <SectionLabel label={t("academy.objectiveLabel")} />
      <T step="base" tone="text2">
        {localize(video.objective, lang)}
      </T>

      <SectionLabel label={t("academy.stepsLabel")} style={{ marginTop: 24 }} />
      <View style={{ gap: 8 }}>
        {localizeSteps(video.steps, lang).map((step, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
            <T step="codenote" tone="text3" style={{ width: 20, marginTop: 6 }}>
              {String(i + 1).padStart(2, "0")}
            </T>
            <T step="base" tone="text2" style={{ flex: 1 }}>
              {step}
            </T>
          </View>
        ))}
      </View>

      <SectionLabel label={t("academy.transcriptLabel")} style={{ marginTop: 24 }} />
      <T step="base" tone="text3" style={{ lineHeight: 26 }}>
        {localize(video.transcript, lang)}
      </T>
      <View style={{ height: 1, backgroundColor: c.bgSheet }} />
    </Page>
  )
}
