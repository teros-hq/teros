/**
 * Launcher Window Content
 *
 * Shows the window types the viewer may open (their `audience`), grouped as
 * Empezar / Trabajo / Apps / Cuenta / Admin / Herramientas, with a filter
 * box. A type without a section is not shown. When user selects one, it replaces this launcher
 * window with the selected type (Cmd/Ctrl+click opens a new tab).
 */

import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { NewConversationModal } from "../../components/NewConversationModal"
import { useClickModifiers } from "../../hooks/useClickModifiers"
import { windowRegistry, type WindowTypeDefinition } from "../../services/windowRegistry"
import { SECTION_OF, SECTION_ORDER, type SectionKey, launcherTypes, orderInSection } from "./launcherModel"
import { getResolvedFlag, useFeatureFlagsStore } from "../../store/featureFlagsStore"
import { useAuthStore } from "../../store/authStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Card,
  Field,
  Grid,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  T,
  Tile,
} from "../../components/ui/ds"

interface Props {
  windowId: string
}

/** Default one-line descriptions (overridable through i18n `launcher.sub.<type>`). */
const SUB_DEFAULT: Record<string, string> = {
  conversations: "Busca en el contenido de todos los chats",
  "archived-conversations": "Lo que ya cerrasteis",
  "pending-approvals": "Lo que tus agentes esperan que apruebes",
  "create-agent": "Plantillas de rol para empezar",
  board: "Tableros y Autoplay",
  todo: "Tus tareas pendientes",
  apps: "Instaladas en este workspace",
  catalog: "Instala apps nuevas",
  skills: "Instrucciones reutilizables",
  academy: "Videotutoriales por fases",
  workspaces: "Chats, agentes, apps y proyectos",
  providers: "Tus claves de LLM",
  profile: "Tu cuenta y preferencias",
  users: "Cuentas, roles y acceso",
  mcas: "Estado y salud de las apps",
  "agent-cores": "Plantillas base de los agentes",
  monitoring: "Métricas del sistema",
  "model-health": "Latencia y errores por modelo",
  "agent-usage": "Actividad de los agentes",
  "billing-requests": "Solicitudes de facturación",
  "billing-teams": "Equipos y planes",
  "billing-audit": "Registro de cambios de facturación",
  "feature-flags": "Interruptores de producto",
  "latitude-signals": "Señales de evaluación",
  console: "Logs y eventos en vivo",
  terminal: "Una shell en el volumen",
  "file-browser": "Los archivos del workspace",
  flowList: "Automatizaciones paso a paso",
  automate: "Horarios, webhooks y eventos que crean trabajo",
}

export function LauncherWindowContent({ windowId }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const { replaceWindow, openWindow } = useTilingStore()
  const { shouldOpenInNewTab } = useClickModifiers()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const userRole = useAuthStore((s) => s.user?.role)
  // Subscribe to flags cache so the launcher re-renders when flags change
  const flags = useFeatureFlagsStore((s) => s.flags)
  const devtools = !!getResolvedFlag<boolean>({ flags }, "devtools.enabled")
  const [query, setQuery] = useState("")
  const launchers = launcherTypes(
    windowRegistry.getAll(),
    { role: userRole, devtools },
    (flag) => !!getResolvedFlag<boolean>({ flags }, flag),
  )
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)

  /** Normalise RN-Web / Tamagui press events for the modifier check. */
  const modifierEvent = (e?: any) => {
    const n = e?.nativeEvent ?? {}
    return {
      ctrlKey: e?.ctrlKey ?? n.ctrlKey ?? false,
      metaKey: e?.metaKey ?? n.metaKey ?? false,
      button: e?.button ?? n.button ?? 0,
    }
  }

  const handleSelect = (type: string, e?: any) => {
    if (e && shouldOpenInNewTab(modifierEvent(e))) {
      openWindow(type, {}, true, windowId)
      return
    }
    replaceWindow(windowId, type, {})
  }

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      false,
      windowId,
    )
  }

  const sectionLabel: Record<SectionKey, string> = {
    start: t("launcher.sections.start", { defaultValue: "Empezar" }),
    work: t("launcher.sections.work", { defaultValue: "Trabajo" }),
    apps: t("launcher.sections.apps", { defaultValue: "Apps" }),
    account: t("launcher.sections.account", { defaultValue: "Cuenta" }),
    admin: t("launcher.sections.admin", { defaultValue: "Admin" }),
    tools: t("launcher.sections.tools", { defaultValue: "Herramientas" }),
  }

  const subtitleOf = (def: WindowTypeDefinition<any>): string | undefined => {
    const fromDef = def.getSubtitle?.({})
    const fallback = SUB_DEFAULT[def.type]
    return t(`launcher.sub.${def.type}`, { defaultValue: fromDef || fallback || "" }) || undefined
  }

  // Type to filter: title or description, accent-insensitive.
  const norm = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
  const q = norm(query.trim())
  const matches = (title: string, sub?: string) =>
    !q || norm(title).includes(q) || (!!sub && norm(sub).includes(q))
  const newChatTitle = t("nav.newConversation")
  const newChatSub = t("launcher.sub.new-chat", { defaultValue: "Elige un agente y empieza" })
  const showNewChat = matches(newChatTitle, newChatSub)

  // Group into sections (stable registry order inside each).
  const grouped = new Map<SectionKey, WindowTypeDefinition<any>[]>()
  for (const def of launchers) {
    if (!matches(def.getTitle({}), subtitleOf(def))) continue
    const key = SECTION_OF[def.type]
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(def)
  }
  const nothing = !showNewChat && grouped.size === 0

  const renderCard = (opts: {
    key: string
    icon: React.ReactNode
    title: string
    sub?: string
    onPress: (e?: any) => void
    testID?: string
  }) => (
    <Card key={opts.key} hov onPress={opts.onPress} pad={14} testID={opts.testID}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {opts.icon}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="base" ellipsis>
            {opts.title}
          </T>
          {opts.sub ? (
            <T step="sm" tone="text3" numberOfLines={2}>
              {opts.sub}
            </T>
          ) : null}
        </View>
        <Ph name="arrow-up-right" size={14} color={c.text3} />
      </View>
    </Card>
  )

  return (
    <Page>
      <PageHead
        eyebrow={t("launcher.eyebrow", { defaultValue: "Launcher" })}
        title={t("launcher.title", { defaultValue: "¿Qué abrimos?" })}
        lead={t("launcher.lead", {
          defaultValue:
            "Cada ventana se abre en este panel. Arrastra su pestaña al borde para dividir.",
        })}
      />

      <View style={{ marginBottom: 22, maxWidth: 420 }}>
        <Field
          icon="magnifying-glass"
          placeholder={t("launcher.search", { defaultValue: "Buscar ventana…" })}
          value={query}
          onChangeText={setQuery}
          autoFocus={Platform.OS === "web"}
          testID="launcher-search"
        />
      </View>

      {nothing ? (
        <T step="sm" tone="text3" style={{ marginBottom: 20 }}>
          {t("launcher.noResults", { defaultValue: "Nada coincide con esa búsqueda." })}
        </T>
      ) : null}

      {SECTION_ORDER.map((key) => {
        const defs = orderInSection(key, grouped.get(key) ?? [])
        const isStart = key === "start" && showNewChat
        if (defs.length === 0 && !isStart) return null
        return (
          <View key={key} style={{ marginBottom: 20 }}>
            <SectionLabel label={sectionLabel[key]} />
            <Grid cols={3} min={230}>
              {isStart
                ? renderCard({
                    key: "new-chat",
                    icon: <Tile sm icon="chat-circle" />,
                    title: newChatTitle,
                    sub: newChatSub,
                    onPress: () => setShowNewConversationModal(true),
                    testID: "launcher-new-chat",
                  })
                : null}
              {defs.map((def) => {
                const LucideIcon = def.icon as any
                const icon = def.phIcon ? (
                  <Tile sm icon={def.phIcon} />
                ) : (
                  <Tile sm>
                    {typeof LucideIcon === "function" || typeof LucideIcon === "object" ? (
                      <LucideIcon size={18} color={c.accent} />
                    ) : null}
                  </Tile>
                )
                return renderCard({
                  key: def.type,
                  icon,
                  title: def.getTitle({}),
                  sub: subtitleOf(def),
                  onPress: (e) => handleSelect(def.type, e),
                  testID: `launcher-${def.type}`,
                })
              })}
            </Grid>
          </View>
        )
      })}

      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />
      {Platform.OS === "web" ? null : <View style={{ height: 24 }} />}
    </Page>
  )
}
