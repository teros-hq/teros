/**
 * AutomateWindowContent — the Automate window, laid out like the Launcher.
 *
 *   <Page>
 *     <PageHead eyebrow · serif title · lead (counts) · [search] [+ New] />
 *     chips: trigger facets (with counts) · status · action
 *     one section per trigger kind (SectionLabel + Grid of StarterCards),
 *     or a single section when filtering
 *   </Page>
 *   ConfirmDialog (delete) · WebhookUrlDialog (URL shown once)
 *
 * Opening a card or "+ New" swaps the page for AutomationDetailScreen
 * (local state, like Academy's catalog → detail). Mutations reload the list
 * from automate.list so stats and display names stay authoritative.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { useColors } from '../../components/mca/primitives/useColors'
import { FullscreenLoader } from '../../components/ui'
import {
  Btn,
  ChipBtn,
  EmptyState,
  Field,
  Grid,
  IconBtn,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  T,
} from '../../components/ui/ds'
import { getTerosClient } from '../../services/terosClientSingleton'
import { useTilingStore } from '../../store/tilingStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ConfirmDialog } from '../UsersWindow/detail/ConfirmDialog'
import { AutomationDetailScreen } from './AutomationDetailScreen'
import { QuotaStrip } from './QuotaStrip'
import { StarterCard, knownStarter } from './StarterCard'
import { ACTION_ORDER, TRIGGER_ORDER, TRIGGER_SECTION, actionMeta, triggerMeta } from './starter-meta'
import { WebhookUrlDialog } from './WebhookUrlDialog'
import {
  DEFAULT_STARTER_FILTERS,
  filterStarters,
  hasActiveFilters,
  type ActionType,
  type AutomateQuota,
  type AutomateStarter,
  type StarterFiltersState,
  type StarterType,
} from './types/automate'

export type AutomateWindowProps = Record<string, never>

type Screen = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; starterId: string }

export function AutomateWindowContent(props: AutomateWindowProps & { windowId: string }) {
  const { windowId } = props
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const openWindow = useTilingStore((state) => state.openWindow)

  const [starters, setStarters] = useState<AutomateStarter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<Screen>({ kind: 'list' })
  const [filters, setFilters] = useState<StarterFiltersState>({ ...DEFAULT_STARTER_FILTERS })
  const [pendingDelete, setPendingDelete] = useState<AutomateStarter | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null)
  const [quota, setQuota] = useState<AutomateQuota | null>(null)
  // Bumped on every live run so an open detail screen reloads its history.
  const [executionsVersion, setExecutionsVersion] = useState(0)

  // ── Data ──────────────────────────────────────────────────────────────────

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!activeWorkspaceId) {
        setStarters([])
        setLoading(false)
        return
      }
      if (!opts?.silent) setLoading(true)
      setError(null)
      try {
        const res = await client.automate.listStarters(activeWorkspaceId)
        setStarters(res.starters)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('automate.errors.load', { defaultValue: 'Could not load automations' }))
      } finally {
        setLoading(false)
      }
    },
    [activeWorkspaceId, client, t],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Daily budget: loaded with the list and refreshed when the backend says
  // today's runs are spent (automate.quota-exhausted, once a day).
  const loadQuota = useCallback(async () => {
    try {
      setQuota(await client.automate.getQuota())
    } catch (err) {
      console.warn('[AutomateWindow] quota unavailable:', err instanceof Error ? err.message : err)
    }
  }, [client])

  useEffect(() => {
    void loadQuota()
    const onExhausted = () => void loadQuota()
    // Live feed: the backend sends the fresh budget with every run of one of
    // the user's starters. The strip updates from the payload; the list is
    // reloaded silently so lastExecutionAt / runs-per-day follow along.
    const onUpdated = (data: unknown) => {
      const d = data as Partial<AutomateQuota> | null
      if (!d || typeof d.limit !== 'number' || typeof d.used !== 'number') return
      setQuota({
        limit: d.limit,
        used: d.used,
        remaining: typeof d.remaining === 'number' ? d.remaining : null,
        exhausted: d.exhausted === true,
        planId: typeof d.planId === 'string' ? d.planId : '',
        planName: typeof d.planName === 'string' ? d.planName : '',
        resetsAt: typeof d.resetsAt === 'string' ? d.resetsAt : '',
        topStarters: Array.isArray(d.topStarters) ? d.topStarters : [],
      })
      setExecutionsVersion((v) => v + 1)
      void load({ silent: true })
    }
    client.on('automate.quota-exhausted', onExhausted)
    client.on('automate.quota-updated', onUpdated)
    return () => {
      client.off('automate.quota-exhausted', onExhausted)
      client.off('automate.quota-updated', onUpdated)
    }
  }, [client, loadQuota, load])

  const handleUpgrade = () => {
    // Preview routing (preview-tabs.md): a plain click reuses the desktop's
    // preview tab; only ctrl/cmd-click opens a separate tab.
    openWindow('profile', { initialMode: 'plan' }, false, windowId)
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  const handleToggle = async (starterId: string, nextEnabled: boolean) => {
    if (!activeWorkspaceId) return
    const previous = starters
    setStarters((prev) => prev.map((s) => (s.starterId === starterId ? { ...s, enabled: nextEnabled } : s)))
    try {
      await client.automate.setEnabled(activeWorkspaceId, starterId, nextEnabled)
    } catch (err) {
      setStarters(previous)
      setError(err instanceof Error ? err.message : t('automate.errors.toggle', { defaultValue: 'Could not update status' }))
    }
  }

  const handleConfirmDelete = async () => {
    if (!activeWorkspaceId || !pendingDelete) return
    setDeleting(true)
    try {
      await client.automate.deleteStarter(activeWorkspaceId, pendingDelete.starterId)
      setStarters((prev) => prev.filter((s) => s.starterId !== pendingDelete.starterId))
      if (view.kind === 'edit' && view.starterId === pendingDelete.starterId) setView({ kind: 'list' })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automate.errors.delete', { defaultValue: 'Could not delete automation' }))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const handleOpenChannel = (channelId: string) => {
    // Preview routing (preview-tabs.md): a plain click reuses the desktop's
    // preview tab; only ctrl/cmd-click opens a separate tab.
    openWindow('chat', { channelId }, false, windowId)
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const filtering = hasActiveFilters(filters)
  // Defensive: drop starters whose trigger/action type the frontend does not
  // know (legacy/malformed docs in a prod DB). Rendering them crashed the
  // window in prod cloud — they stay out of the grid until the type is known.
  const known = useMemo(() => starters.filter(knownStarter), [starters])
  const visible = useMemo(
    () => (filtering ? filterStarters(known, filters) : known),
    [known, filters, filtering],
  )
  const activeCount = known.filter((s) => s.enabled).length
  const countByTrigger = useMemo(() => {
    const map: Record<StarterType, number> = { scheduler: 0, once: 0, webhook: 0, event: 0 }
    for (const s of known) map[s.type]++
    return map
  }, [starters])
  const countByAction = useMemo(() => {
    const map: Record<ActionType, number> = { 'create-task': 0, 'channel-event': 0, 'start-flow': 0 }
    for (const s of known) map[s.action.type]++
    return map
  }, [starters])

  // Grouped by trigger when browsing; one flat section when filtering.
  const sections = useMemo(() => {
    if (filtering) {
      return [{ key: 'results', label: t('automate.filters.results', { defaultValue: 'Results' }), items: visible }]
    }
    return TRIGGER_ORDER.map((type) => ({
      key: type,
      label: t(TRIGGER_SECTION[type].key, { defaultValue: TRIGGER_SECTION[type].fallback }),
      items: visible.filter((s) => s.type === type),
    })).filter((section) => section.items.length > 0)
  }, [visible, filtering, t])

  // ── Detail screens ────────────────────────────────────────────────────────

  if (!activeWorkspaceId) {
    return (
      <Page>
        <EmptyState
          icon="lightning"
          title={t('automate.noWorkspace', { defaultValue: 'No workspace selected' })}
        />
      </Page>
    )
  }

  if (view.kind === 'create' || view.kind === 'edit') {
    const starter = view.kind === 'edit' ? (starters.find((s) => s.starterId === view.starterId) ?? null) : null
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
        <AutomationDetailScreen
          starter={starter}
          workspaceId={activeWorkspaceId}
          dailyLimit={quota?.limit ?? 0}
          executionsVersion={executionsVersion}
          onBack={() => setView({ kind: 'list' })}
          onSaved={async () => {
            await load({ silent: true })
            setView({ kind: 'list' })
          }}
          onDelete={starter ? () => setPendingDelete(starter) : undefined}
          onRevealUrl={setRevealedUrl}
        />
        <ConfirmDialog
          open={pendingDelete !== null}
          title={t('automate.deleteDialog.title', { defaultValue: 'Delete automation' })}
          body={t('automate.deleteDialog.body', {
            defaultValue: 'Delete "{{name}}"? It stops firing immediately. Tasks, messages and flow runs it already produced are kept.',
            name: pendingDelete?.name ?? '',
          })}
          confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
          cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
          tone="danger"
          busy={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            if (!deleting) setPendingDelete(null)
          }}
        />
        <WebhookUrlDialog url={revealedUrl} onClose={() => setRevealedUrl(null)} />
      </View>
    )
  }

  // ── List ──────────────────────────────────────────────────────────────────

  const triggerChip = (type: StarterType) => {
    const meta = triggerMeta(type)
    return (
      <ChipBtn
        key={type}
        on={filters.trigger === type}
        icon={meta.icon}
        count={countByTrigger[type]}
        onPress={() => setFilters((f) => ({ ...f, trigger: f.trigger === type ? 'all' : type }))}
        testID={`automate-filter-${type}`}
      >
        {t(meta.labelKey, { defaultValue: meta.labelFallback })}
      </ChipBtn>
    )
  }

  const actionChip = (type: ActionType) => {
    const meta = actionMeta(type)
    return (
      <ChipBtn
        key={type}
        on={filters.action === type}
        icon={meta.icon}
        count={countByAction[type]}
        onPress={() => setFilters((f) => ({ ...f, action: f.action === type ? 'all' : type }))}
        testID={`automate-filter-${type}`}
      >
        {t(meta.labelKey, { defaultValue: meta.labelFallback })}
      </ChipBtn>
    )
  }

  const divider = <View style={{ width: 1, height: 18, backgroundColor: c.border, marginHorizontal: 4 }} />

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      <Page>
        <PageHead
          eyebrow={t('automate.eyebrow', { defaultValue: 'Automate' })}
          title={t('automate.headline', { defaultValue: 'What runs on its own.' })}
          accent={t('automate.headlineAccent', { defaultValue: 'on its own.' })}
          lead={
            loading
              ? undefined
              : known.length === 0
                ? t('automate.leadEmpty', {
                    defaultValue:
                      'Couple a trigger — a schedule, a webhook or an event — with what should happen: a task, a message to a channel or a flow.',
                  })
                : t('automate.lead', {
                    defaultValue: '{{count}} automations · {{active}} active',
                    count: known.length,
                    active: activeCount,
                  })
          }
          actions={
            <>
              <Field
                icon="magnifying-glass"
                value={filters.search}
                onChangeText={(search) => setFilters((f) => ({ ...f, search }))}
                placeholder={t('automate.search', { defaultValue: 'Search automations…' })}
                containerStyle={{ width: 220 }}
                testID="automate-search"
              />
              <Btn variant="primary" icon="plus" onPress={() => setView({ kind: 'create' })} testID="automate-new">
                {t('automate.new', { defaultValue: 'New automation' })}
              </Btn>
            </>
          }
        />

        {/* Error banner */}
        {error ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              paddingHorizontal: 14,
              borderRadius: 10,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
              marginBottom: 16,
            }}
          >
            <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
            <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
              {error}
            </T>
            <IconBtn icon="x" plain sm danger onPress={() => setError(null)} title={t('common.close', { defaultValue: 'Close' })} />
          </View>
        ) : null}

        <QuotaStrip
          quota={quota}
          onUpgrade={handleUpgrade}
          onOpenStarter={(starterId) => {
            if (starters.some((s) => s.starterId === starterId)) setView({ kind: 'edit', starterId })
          }}
        />

        {/* Filter chips — only once there is something to filter */}
        {starters.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            {TRIGGER_ORDER.map(triggerChip)}
            {divider}
            <ChipBtn
              on={filters.status === 'active'}
              icon="play"
              onPress={() => setFilters((f) => ({ ...f, status: f.status === 'active' ? 'all' : 'active' }))}
              testID="automate-filter-active"
            >
              {t('automate.filters.active', { defaultValue: 'Active' })}
            </ChipBtn>
            <ChipBtn
              on={filters.status === 'disabled'}
              icon="pause"
              onPress={() => setFilters((f) => ({ ...f, status: f.status === 'disabled' ? 'all' : 'disabled' }))}
              testID="automate-filter-disabled"
            >
              {t('automate.filters.disabled', { defaultValue: 'Disabled' })}
            </ChipBtn>
            {divider}
            {ACTION_ORDER.map(actionChip)}
            {filtering ? (
              <Btn variant="ghost" size="sm" icon="x" onPress={() => setFilters({ ...DEFAULT_STARTER_FILTERS })} testID="automate-filter-clear">
                {t('automate.filters.clear', { defaultValue: 'Clear' })}
              </Btn>
            ) : null}
          </View>
        ) : null}

        {/* Content */}
        {loading ? (
          <View style={{ minHeight: 240 }}>
            <FullscreenLoader variant="default" label={t('automate.loading', { defaultValue: 'Loading automations…' })} />
          </View>
        ) : known.length === 0 ? (
          <EmptyState
            icon="lightning"
            title={t('automate.empty.title', { defaultValue: 'No automations yet' })}
            text={t('automate.empty.text', {
              defaultValue: 'Start with a schedule, a webhook or an event. The first one takes a minute.',
            })}
            action={
              <Btn variant="primary" icon="plus" onPress={() => setView({ kind: 'create' })}>
                {t('automate.new', { defaultValue: 'New automation' })}
              </Btn>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="magnifying-glass"
            title={t('automate.empty.filteredTitle', { defaultValue: 'No automations match' })}
            text={t('automate.empty.filteredText', { defaultValue: 'Try another search or clear the filters.' })}
            action={
              <Btn variant="sec" icon="x" onPress={() => setFilters({ ...DEFAULT_STARTER_FILTERS })}>
                {t('automate.filters.clear', { defaultValue: 'Clear' })}
              </Btn>
            }
          />
        ) : (
          sections.map((section) => (
            <View key={section.key} style={{ marginBottom: 12 }}>
              <SectionLabel label={section.label} count={section.items.length} />
              <Grid cols={3} min={260}>
                {section.items.map((starter) => (
                  <StarterCard
                    key={starter.starterId}
                    starter={starter}
                    onOpen={(starterId) => setView({ kind: 'edit', starterId })}
                    onToggle={handleToggle}
                    onDelete={(starterId) => {
                      const s = starters.find((x) => x.starterId === starterId)
                      if (s) setPendingDelete(s)
                    }}
                    onOpenChannel={handleOpenChannel}
                  />
                ))}
              </Grid>
            </View>
          ))
        )}
      </Page>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('automate.deleteDialog.title', { defaultValue: 'Delete automation' })}
        body={t('automate.deleteDialog.body', {
          defaultValue: 'Delete "{{name}}"? It stops firing immediately. Tasks, messages and flow runs it already produced are kept.',
          name: pendingDelete?.name ?? '',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        busy={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null)
        }}
      />
      <WebhookUrlDialog url={revealedUrl} onClose={() => setRevealedUrl(null)} />
    </View>
  )
}
