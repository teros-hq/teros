/**
 * AgentHero — the agent page header card of the OS prototype (`.tm-ahead`):
 * a 24px-radius card with a violet glow bleeding in from the top-right,
 * the 96px story avatar with a round camera button, the serif name, the
 * role in mono caps, meta badges, and the actions column (violet "new chat"
 * pill + phone / palette / dots icon buttons).
 */
import React from "react"
import { Platform, Pressable, View, type ViewStyle, useWindowDimensions } from "react-native"
import { Avatar } from "../../components/Avatar"
import { AppSpinner } from "../../components/ui"
import { Badge, Btn, Card, IconBtn, Ph, T } from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"

export interface AgentHeroProps {
  name: string
  fullName?: string
  role?: string
  avatarUrl?: string | null
  /** Mono badges under the role line (model · N apps · N skills). */
  badges: Array<{ icon: string; label: string }>
  uploading?: boolean
  avatarHint?: string
  onAvatarPress: () => void
  newChatLabel: string
  onNewChat: () => void
  voiceLabel: string
  onVoice: () => void
  appearanceLabel: string
  onAppearance: () => void
  moreLabel: string
  menuOpen: boolean
  onToggleMenu: () => void
  /** Rows of the ⋮ menu. */
  menu: Array<{ icon: string; label: string; danger?: boolean; onPress: () => void }>
  style?: ViewStyle
}

export function AgentHero({
  name,
  fullName,
  role,
  avatarUrl,
  badges,
  uploading,
  avatarHint,
  onAvatarPress,
  newChatLabel,
  onNewChat,
  voiceLabel,
  onVoice,
  appearanceLabel,
  onAppearance,
  moreLabel,
  menuOpen,
  onToggleMenu,
  menu,
  style,
}: AgentHeroProps) {
  const c = useColors()
  const { width } = useWindowDimensions()
  const column = width <= 620
  const [avHover, setAvHover] = React.useState(false)

  const roleLine = [role, fullName && fullName !== name ? fullName : null]
    .filter(Boolean)
    .join(" · ")

  return (
    <Card
      xl
      pad={column ? 20 : 32}
      style={{ marginBottom: 20, overflow: "visible", ...(style || {}) }}
    >
      {/* Glow — a blurred violet disc bleeding in from the top-right (web only;
          native draws a soft tinted disc instead, there is no filter: blur). */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: 24,
          overflow: "hidden",
        }}
      >
        <View
          style={[
            {
              position: "absolute",
              top: -200,
              right: -120,
              width: 380,
              height: 380,
              borderRadius: 190,
              backgroundColor: semantic.purple300,
              opacity: Platform.OS === "web" ? 0.28 : 0.1,
            },
            Platform.OS === "web" ? ({ filter: "blur(80px)" } as any) : null,
          ]}
        />
      </View>

      <View
        style={{
          flexDirection: column ? "column" : "row",
          alignItems: column ? "flex-start" : "center",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        {/* Avatar + camera */}
        <Pressable
          accessibilityRole="button"
          onPress={onAvatarPress}
          disabled={uploading}
          {...(Platform.OS === "web"
            ? ({
                onHoverIn: () => setAvHover(true),
                onHoverOut: () => setAvHover(false),
                title: avatarHint,
              } as any)
            : {})}
          style={[
            { width: 96, height: 96, borderRadius: 48, opacity: uploading ? 0.7 : 1 },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <Avatar name={name} imageUrl={avatarUrl ?? undefined} size={96} isAgent />
          <View
            style={[
              {
                position: "absolute",
                bottom: -2,
                right: -2,
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: c.bgStep,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: Platform.OS === "web" ? 0 : 1,
                borderColor: c.border,
                transform: [{ scale: avHover ? 1.1 : 1 }],
              },
              Platform.OS === "web"
                ? ({
                    boxShadow: `0 0 0 1px ${c.border}, 0 2px 8px rgba(52,47,61,0.15)`,
                    transition: "transform 0.3s cubic-bezier(.16,1,.3,1), color 0.2s",
                  } as any)
                : null,
            ]}
          >
            {uploading ? (
              <AppSpinner size="sm" variant="muted" />
            ) : (
              <Ph name="camera" size={14} color={avHover ? c.accent : c.text2} />
            )}
          </View>
        </Pressable>

        {/* Name · role · badges */}
        <View style={{ flex: 1, minWidth: 200, gap: 8 }}>
          <T step="2xl" numberOfLines={2}>
            {name}
          </T>
          {roleLine ? (
            <T step="codenote" tone="text3">
              {roleLine}
            </T>
          ) : null}
          {badges.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              {badges.map((b, i) => (
                <Badge key={i} mono icon={b.icon}>
                  {b.label}
                </Badge>
              ))}
            </View>
          ) : null}
        </View>

        {/* Actions column */}
        <View
          style={{
            alignItems: column ? "stretch" : "flex-end",
            gap: 14,
            alignSelf: column ? "stretch" : "center",
            flexDirection: column ? "row" : "column",
            flexWrap: "wrap",
            justifyContent: "space-between",
          }}
        >
          <Btn variant="primary" icon="chat-circle" onPress={onNewChat} testID="agent-new-chat">
            {newChatLabel}
          </Btn>
          <View
            style={{
              flexDirection: "row",
              gap: 4,
              alignItems: "center",
              justifyContent: "flex-end",
            }}
          >
            <IconBtn icon="phone" plain onPress={onVoice} title={voiceLabel} />
            <IconBtn icon="palette" plain onPress={onAppearance} title={appearanceLabel} />
            <View>
              <IconBtn
                icon="dots-three"
                plain
                on={menuOpen}
                onPress={onToggleMenu}
                title={moreLabel}
              />
              {menuOpen ? (
                <View
                  style={[
                    {
                      position: "absolute",
                      top: 40,
                      right: 0,
                      minWidth: 200,
                      padding: 6,
                      borderRadius: 12,
                      backgroundColor: c.bgStep,
                      borderWidth: 1,
                      borderColor: c.border,
                      zIndex: 50,
                    },
                    Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
                  ]}
                >
                  {menu.map((m, i) => (
                    <Pressable
                      key={i}
                      accessibilityRole="menuitem"
                      onPress={m.onPress}
                      style={({ pressed, hovered }: any) => [
                        {
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          paddingVertical: 8,
                          paddingHorizontal: 10,
                          borderRadius: 8,
                          backgroundColor: pressed || hovered ? c.wash : "transparent",
                        },
                        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                      ]}
                    >
                      <Ph name={m.icon} size={15} color={m.danger ? c.tint.r.tx : c.text2} />
                      <T step="sm" color={m.danger ? c.tint.r.tx : c.text}>
                        {m.label}
                      </T>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Card>
  )
}
