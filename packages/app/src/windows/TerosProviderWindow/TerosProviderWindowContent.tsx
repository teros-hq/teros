/**
 * Teros provider — the admin zone (TPROV-REQ-10).
 *
 * Top: the three upstreams with key presence and retention. Then one card per
 * Teros provider config (the default first; the others are assignable per user
 * from Billing) with, per size, two routes — Interactive (a person waits) and
 * Background (automations, scheduled runs, internal tasks) — each with the
 * upstream, the model of that upstream and the reasoning effort, and its own
 * test that runs a text request and an image request through the config; the
 * failover policy (one for both lanes); Save.
 *
 * @spec TPROV-REQ-10, TLANE-REQ-10
 */
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import type {
  TerosFailoverMode,
  TerosLane,
  TerosProviderConfig,
  TerosReasoningEffort,
  TerosSize,
  TerosSizeTestResult,
  TerosUpstream,
  TerosUpstreamInfo,
} from "../../services/AdminApi"
import { useToast } from "../../components/Toast"
import { FullscreenLoader } from "../../components/ui"
import { Badge, Btn, Card, Chip, EmptyState, OptionRow, Page, PageHead, Ph, SectionLabel, Segmented, T } from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import type { TerosProviderWindowProps } from "./definition"
import {
  findModel,
  isDirty,
  LANES,
  modelsOf,
  routeProblem,
  type Routing,
  routingOf,
  SIZES,
  withEffort,
  withFailover,
  withModel,
  withUpstream,
} from "./terosProviderModel"

const UPSTREAM_ORDER: TerosUpstream[] = ["helmcode", "fireworks", "together"]
const UPSTREAM_LABEL: Record<TerosUpstream, string> = { helmcode: "Helmcode", fireworks: "Fireworks", together: "Together" }

/** @spec TPROV-REQ-10 */
export function TerosProviderWindowContent(_props: TerosProviderWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const toast = useToast()
  const [upstreams, setUpstreams] = useState<TerosUpstreamInfo[] | null>(null)
  const [configs, setConfigs] = useState<TerosProviderConfig[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.all([client.admin.getTerosUpstreams(), client.admin.listTerosProviderConfigs()])
      .then(([u, c]) => {
        if (!alive) return
        setUpstreams(u.upstreams)
        setConfigs(c.configs)
      })
      .catch((err) => {
        console.warn("[TerosProvider] load failed:", err)
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  if (failed) return <EmptyState icon="warning-circle" title={t("terosProvider.loadError")} />
  if (!upstreams || !configs) return <FullscreenLoader />

  const ordered = [...upstreams].sort((a, b) => UPSTREAM_ORDER.indexOf(a.upstream) - UPSTREAM_ORDER.indexOf(b.upstream))

  return (
    <Page>
      <PageHead eyebrow={t("nav.administration")} title={t("terosProvider.title")} />
      <T step="sm" tone="text3" style={{ marginBottom: 14 }}>
        {t("terosProvider.sub")}
      </T>

      <SectionLabel label={t("terosProvider.upstreams")} dot={false} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 18 }} testID="teros-upstreams">
        {ordered.map((u) => (
          <View key={u.upstream} testID={`teros-upstream-${u.upstream}`}>
            <Badge tone={u.retention !== "zdr" ? "r" : u.hasSecret ? "g" : "a"}>
              {`${UPSTREAM_LABEL[u.upstream]} · ${u.retention !== "zdr" ? t("terosProvider.notZdr") : u.hasSecret ? t("terosProvider.keyPresent") : t("terosProvider.keyMissing")}`}
            </Badge>
          </View>
        ))}
      </View>

      {configs.length === 0 ? (
        <EmptyState icon="cpu" title={t("terosProvider.noConfigs")} />
      ) : (
        configs.map((config) => (
          <ConfigEditor
            key={config._id}
            config={config}
            upstreams={ordered}
            onSaved={(saved) => setConfigs((cs) => (cs ?? []).map((c) => (c._id === saved._id ? saved : c)))}
            toast={toast}
          />
        ))
      )}
    </Page>
  )
}

function ConfigEditor({
  config,
  upstreams,
  onSaved,
  toast,
}: {
  config: TerosProviderConfig
  upstreams: TerosUpstreamInfo[]
  onSaved: (c: TerosProviderConfig) => void
  toast: ReturnType<typeof useToast>
}) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const saved = useMemo(() => routingOf(config), [config])
  const [draft, setDraft] = useState<Routing>(saved)
  const [saving, setSaving] = useState(false)
  const [tests, setTests] = useState<Partial<Record<`${TerosSize}:${TerosLane}`, TestState>>>({})
  const dirty = isDirty(draft, saved)

  const save = async () => {
    setSaving(true)
    try {
      const { config: next } = await client.admin.updateTerosProviderConfig(config._id, { sizes: draft.sizes, failover: draft.failover })
      onSaved(next)
      setDraft(routingOf(next))
      toast.success(t("terosProvider.saved"), config.name)
    } catch (err: any) {
      toast.error(t("common.error"), err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const test = async (size: TerosSize, lane: TerosLane) => {
    const key = `${size}:${lane}` as const
    const route = draft.sizes[size][lane]
    setTests((s) => ({ ...s, [key]: { running: true } }))
    try {
      const result = await client.admin.testTerosSize(config._id, size, lane, route)
      setTests((s) => ({ ...s, [key]: { result } }))
    } catch (err: any) {
      setTests((s) => ({ ...s, [key]: { result: { ok: false, lane, upstream: route.upstream, model: route.modelString, error: err?.message ?? String(err) } } }))
    }
  }

  const failoverItems: Array<{ key: TerosFailoverMode; label: string }> = [
    { key: "off", label: t("terosProvider.off") },
    { key: "on-error", label: t("terosProvider.onError") },
    { key: "cutover", label: t("terosProvider.cutover") },
  ]

  return (
    <Card pad={16} style={{ marginBottom: 16 }} testID={`teros-config-${config._id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <T step="base">{config.name}</T>
        {config.isDefault ? <Badge tone="i">{t("terosProvider.default")}</Badge> : <Badge tone="muted">{t("terosProvider.assigned")}</Badge>}
        <View style={{ flex: 1 }} />
        {dirty ? (
          <T step="12" tone="text3">
            {t("terosProvider.dirty")}
          </T>
        ) : null}
        <Btn variant="primary" size="sm" onPress={save} disabled={!dirty || saving} testID={`teros-save-${config._id}`}>
          {t("terosProvider.save")}
        </Btn>
      </View>

      {SIZES.map((size) => (
        <View key={size} style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12, marginTop: 4, marginBottom: 10 }} testID={`teros-size-${size}`}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <T step="sm">{t(`terosProvider.size${size.toUpperCase()}`)}</T>
            <T step="12" tone="text3">
              {t(`terosProvider.size${size.toUpperCase()}Sub`)}
            </T>
          </View>
          {LANES.map((lane) => (
            <LaneEditor
              key={lane}
              size={size}
              lane={lane}
              routing={draft}
              upstreams={upstreams}
              onChange={(update) => setDraft(update)}
              test={tests[`${size}:${lane}`]}
              onTest={() => void test(size, lane)}
            />
          ))}
        </View>
      ))}

      <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12, marginTop: 4 }} testID="teros-failover">
        <T step="sm" style={{ marginBottom: 2 }}>
          {t("terosProvider.failover")}
        </T>
        <T step="12" tone="text3" style={{ marginBottom: 8 }}>
          {t("terosProvider.failoverSub")}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Segmented<TerosFailoverMode> items={failoverItems} value={draft.failover.mode} onChange={(mode) => setDraft((d) => withFailover(d, { mode }))} />
          <View style={{ flexDirection: "row", gap: 6 }}>
            {upstreams.map((u) => (
              <Chip key={u.upstream} on={draft.failover.upstream === u.upstream} onPress={() => setDraft((d) => withFailover(d, { upstream: u.upstream }))} testID={`teros-failover-${u.upstream}`}>
                {UPSTREAM_LABEL[u.upstream]}
              </Chip>
            ))}
          </View>
        </View>
      </View>
    </Card>
  )
}

type TestState = { running?: boolean; result?: TerosSizeTestResult }

/** One lane of a size: upstream, model, effort and its test (TLANE-REQ-10). */
function LaneEditor({
  size,
  lane,
  routing,
  upstreams,
  onChange,
  test,
  onTest,
}: {
  size: TerosSize
  lane: TerosLane
  routing: Routing
  upstreams: TerosUpstreamInfo[]
  onChange: (update: (d: Routing) => Routing) => void
  test: TestState | undefined
  onTest: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const route = routing.sizes[size][lane]
  const models = modelsOf(upstreams, route.upstream)
  const model = findModel(upstreams, route)
  const problem = routeProblem(upstreams, route)
  const laneKey = lane === "interactive" ? "laneInteractive" : "laneBackground"
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 12, marginBottom: 12 }} testID={`teros-lane-${size}-${lane}`}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <T step="12">{t(`terosProvider.${laneKey}`)}</T>
        <T step="12" tone="text3">
          {t(`terosProvider.${laneKey}Sub`)}
        </T>
        <View style={{ flex: 1 }} />
        {model ? <Badge tone={model.vision ? "g" : "muted"}>{model.vision ? t("terosProvider.vision") : t("terosProvider.noVision")}</Badge> : null}
        {problem ? <Badge tone="r">{problem === "no-key" ? t("terosProvider.keyMissing") : t("terosProvider.notZdr")}</Badge> : null}
      </View>

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {upstreams.map((u) => (
          <Chip
            key={u.upstream}
            on={route.upstream === u.upstream}
            onPress={() => onChange((d) => withUpstream(d, upstreams, size, lane, u.upstream))}
            testID={`teros-${size}-${lane}-upstream-${u.upstream}`}
          >
            {UPSTREAM_LABEL[u.upstream]}
          </Chip>
        ))}
      </View>

      <View style={{ marginBottom: 8 }}>
        {models.map((m) => (
          <OptionRow
            key={m.modelString}
            on={route.modelString === m.modelString}
            title={m.name}
            sub={m.modelString}
            onPress={() => onChange((d) => withModel(d, upstreams, size, lane, route.upstream, m.modelString))}
            right={m.vision ? <Ph name="eye" size={13} color={c.text3} /> : undefined}
          />
        ))}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <T step="12" tone="text3">
          {t("terosProvider.effort")}
        </T>
        <Segmented<TerosReasoningEffort>
          items={(model?.efforts ?? ["low", "medium", "high"]).map((e) => ({ key: e, label: e === "medium" ? "med" : e }))}
          value={route.reasoningEffort}
          onChange={(e) => onChange((d) => withEffort(d, size, lane, e))}
        />
        <View style={{ flex: 1 }} />
        <Btn variant="sec" size="sm" icon="play" onPress={onTest} disabled={!!test?.running || !!problem} testID={`teros-test-${size}-${lane}`}>
          {test?.running ? t("terosProvider.testing") : t("terosProvider.test")}
        </Btn>
      </View>
      {test?.result ? <TestLine result={test.result} /> : null}
    </View>
  )
}

function TestLine({ result }: { result: TerosSizeTestResult }) {
  const { t } = useTranslation()
  if (!result.ok) {
    return (
      <T step="12" tone="text3" style={{ marginTop: 6 }} testID="teros-test-result">
        {`✕ ${t("terosProvider.testFailed", { error: result.error ?? "" })}`}
      </T>
    )
  }
  const img = result.image
  const imageLine = img
    ? img.error && img.vision === null
      ? t("terosProvider.testFailed", { error: img.error })
      : `${img.vision ? t("terosProvider.testImageOk") : t("terosProvider.testImageNo")}${
          img.rerouted && img.reroutedTo ? ` · ${t("terosProvider.testImageRerouted", { model: img.reroutedTo })}` : ""
        }${img.vision && !img.catalogueVision ? ` · ${t("terosProvider.testCatalogueStale")}` : ""}`
    : ""
  return (
    <T step="12" tone="text3" style={{ marginTop: 6 }} testID="teros-test-result">
      {`✓ ${result.upstream} · ${t("terosProvider.testOk", { model: result.model, ms: result.latencyMs ?? 0 })}${result.text ? ` · "${result.text}"` : ""}${imageLine ? ` · ${imageLine}` : ""}`}
    </T>
  )
}
