/**
 * AcademyCatalog — the Academy catalog in the OS prototype's language (TER-716).
 *
 *  • page head: eyebrow, serif title, lead, a search Field;
 *  • phase filter chips (ChipBtn) + a result count + a GRID/LIST Segmented;
 *  • results as a 3-column Grid of `Card hov` video tiles, or an LGroup list.
 *
 * The catalog is a FLAT grid with phase filter chips (not phase-grouped
 * sections); selecting a chip surfaces that phase's title + description above
 * the results. See docs/specs/ui/academy-videotutoriales.md §3.2.
 */
import { useMemo, useState } from "react"
import { ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import {
  ACADEMY_PHASES,
  filterVideos,
  getPhase,
  localize,
  resolveContentLang,
  type PhaseId,
} from "../../data/academyCatalog"
import { AcademyVideoCard } from "./AcademyVideoCard"
import {
  ChipBtn,
  EmptyState,
  Field,
  Grid,
  LGroup,
  Page,
  PageHead,
  Segmented,
  T,
  Tile,
} from "../../components/ui/ds"

type PhaseFilter = PhaseId | "all"
type Layout = "grid" | "list"

export function AcademyCatalog({ onSelectVideo }: { onSelectVideo: (videoId: string) => void }) {
  const { t, i18n } = useTranslation()
  const contentLang = resolveContentLang(i18n.language)
  const [query, setQuery] = useState("")
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>("all")
  const [layout, setLayout] = useState<Layout>("grid")

  const results = useMemo(() => filterVideos(phaseFilter, query), [phaseFilter, query])
  const chips: PhaseFilter[] = ["all", ...ACADEMY_PHASES.map((p) => p.id)]
  const phaseShort = t("academy.phaseShort")
  const selectedPhase = phaseFilter === "all" ? undefined : getPhase(phaseFilter)

  const renderCard = (video: (typeof results)[number]) => (
    <AcademyVideoCard
      key={video.id}
      video={video}
      layout={layout}
      phaseLabel={`${phaseShort} ${getPhase(video.phase)?.order ?? ""}`}
      videoLabel={t("academy.videoLabel")}
      objectiveText={localize(video.objective, contentLang)}
      onPress={() => onSelectVideo(video.id)}
    />
  )

  return (
    <Page>
      <PageHead
        eyebrow={t("academy.eyebrow", { defaultValue: "Aprende Teros" })}
        title={t("academy.title")}
        lead={t("academy.subtitle")}
        actions={
          <Field
            icon="magnifying-glass"
            value={query}
            onChangeText={setQuery}
            placeholder={t("academy.searchPlaceholder")}
            accessibilityLabel={t("academy.searchPlaceholder")}
            containerStyle={{ width: 300, maxWidth: "100%" }}
          />
        }
      />

      {/* Phase filter chips + toolbar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 1 }}
        >
          <View style={{ flexDirection: "row", gap: 6 }}>
            {chips.map((id) => {
              const active = phaseFilter === id
              const label =
                id === "all" ? t("academy.allPhases") : `${phaseShort} ${getPhase(id)?.order ?? ""}`
              return (
                <ChipBtn
                  key={id}
                  on={active}
                  onPress={() => setPhaseFilter(id)}
                  accessibilityLabel={
                    id === "all" ? t("academy.allPhases") : (getPhase(id)?.title ?? label)
                  }
                  testID={`academy-phase-${id}`}
                >
                  {label}
                </ChipBtn>
              )
            })}
          </View>
        </ScrollView>
        <View style={{ flex: 1 }} />
        <T step="codenote" tone="text3">{`${results.length} ${t("academy.resultsLabel")}`}</T>
        <Segmented
          value={layout}
          onChange={setLayout}
          items={[
            { key: "grid", label: t("academy.gridView"), icon: "squares-four" },
            { key: "list", label: t("academy.listView"), icon: "list" },
          ]}
          style={{ width: 200 }}
        />
      </View>

      {/* Selected-phase header (title + description) — surfaced when filtering */}
      {selectedPhase && (
        <View style={{ gap: 4, marginBottom: 16 }}>
          <T step="xl">{selectedPhase.title}</T>
          <T step="sm" tone="text2">
            {selectedPhase.description}
          </T>
        </View>
      )}

      {/* Results */}
      {results.length === 0 ? (
        <LGroup>
          <View style={{ alignItems: "center", paddingTop: 40 }}>
            <Tile icon="graduation-cap" />
          </View>
          <EmptyState title={t("academy.noResults")} style={{ paddingTop: 12 }} />
        </LGroup>
      ) : layout === "grid" ? (
        <Grid cols={3} min={250}>
          {results.map(renderCard)}
        </Grid>
      ) : (
        <LGroup>{results.map(renderCard)}</LGroup>
      )}
    </Page>
  )
}
